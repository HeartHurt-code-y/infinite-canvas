import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export const PREVIEW_REFRESH_LEAD_MS = 60_000;

export interface ResolvedAssetPreview {
  readonly url: string;
  readonly expiresAt: number | null;
}

export type ResolveAssetPreview = (
  assetId: string,
  forceRefresh: boolean,
) => Promise<ResolvedAssetPreview>;

interface AssetPreviewProps {
  readonly assetId: string;
  readonly alt: string;
  readonly resolvePreview: ResolveAssetPreview;
}

type PreviewState =
  | { readonly assetId: string; readonly status: "loading" }
  | { readonly assetId: string; readonly status: "refreshing" }
  | {
      readonly assetId: string;
      readonly status: "ready";
      readonly preview: ResolvedAssetPreview;
    }
  | { readonly assetId: string; readonly status: "unavailable" };

type RefreshCause = "expiry" | "load-error" | "manual";

function isUsablePreview(preview: ResolvedAssetPreview): boolean {
  return preview.url.trim().length > 0;
}

export function AssetPreview({ assetId, alt, resolvePreview }: AssetPreviewProps) {
  const [state, setState] = useState<PreviewState>({ assetId, status: "loading" });
  const requestVersion = useRef(0);
  const automaticRecoveryUsed = useRef(false);
  const lastFailedUrl = useRef<string | null>(null);

  const refresh = useCallback(
    (cause: RefreshCause, previousPreview: ResolvedAssetPreview | null) => {
      const version = ++requestVersion.current;
      setState({ assetId, status: "refreshing" });

      void resolvePreview(assetId, true).then(
        (resolvedPreview) => {
          if (requestVersion.current !== version) {
            return;
          }

          const repeatedFailedUrl =
            cause !== "expiry" && resolvedPreview.url === lastFailedUrl.current;
          const expiryWasNotExtended =
            cause === "expiry" &&
            previousPreview !== null &&
            resolvedPreview.url === previousPreview.url &&
            resolvedPreview.expiresAt === previousPreview.expiresAt;

          if (!isUsablePreview(resolvedPreview) || repeatedFailedUrl || expiryWasNotExtended) {
            setState({ assetId, status: "unavailable" });
            return;
          }

          setState({ assetId, status: "ready", preview: resolvedPreview });
        },
        () => {
          if (requestVersion.current === version) {
            setState({ assetId, status: "unavailable" });
          }
        },
      );
    },
    [assetId, resolvePreview],
  );

  useEffect(() => {
    const version = ++requestVersion.current;
    automaticRecoveryUsed.current = false;
    lastFailedUrl.current = null;

    void resolvePreview(assetId, false).then(
      (resolvedPreview) => {
        if (requestVersion.current !== version) {
          return;
        }

        setState(
          isUsablePreview(resolvedPreview)
            ? { assetId, status: "ready", preview: resolvedPreview }
            : { assetId, status: "unavailable" },
        );
      },
      () => {
        if (requestVersion.current === version) {
          setState({ assetId, status: "unavailable" });
        }
      },
    );

    return () => {
      requestVersion.current += 1;
    };
  }, [assetId, resolvePreview]);

  const activeState = useMemo<PreviewState>(
    () => (state.assetId === assetId ? state : { assetId, status: "loading" }),
    [assetId, state],
  );

  useEffect(() => {
    if (activeState.status !== "ready" || activeState.preview.expiresAt === null) {
      return;
    }

    const delay = Math.max(0, activeState.preview.expiresAt - Date.now() - PREVIEW_REFRESH_LEAD_MS);
    const timeout = window.setTimeout(() => {
      refresh("expiry", activeState.preview);
    }, delay);

    return () => {
      window.clearTimeout(timeout);
    };
  }, [activeState, refresh]);

  if (activeState.status === "loading") {
    return <span role="status">正在加载素材预览…</span>;
  }

  if (activeState.status === "refreshing") {
    return <span role="status">正在刷新素材预览…</span>;
  }

  if (activeState.status === "unavailable") {
    return (
      <div role="status">
        <span>素材预览暂时不可用，素材和画布连线仍然安全。</span>
        <button
          type="button"
          onClick={() => {
            automaticRecoveryUsed.current = false;
            refresh("manual", null);
          }}
        >
          重试预览
        </button>
      </div>
    );
  }

  return (
    <img
      key={activeState.preview.url}
      src={activeState.preview.url}
      alt={alt}
      onError={() => {
        lastFailedUrl.current = activeState.preview.url;

        if (automaticRecoveryUsed.current) {
          setState({ assetId, status: "unavailable" });
          return;
        }

        automaticRecoveryUsed.current = true;
        refresh("load-error", activeState.preview);
      }}
    />
  );
}
