import { useCallback, useSyncExternalStore } from "react";
import type { PromptContentModule } from "../../lib/promptContent";

/** 摘要仅订阅该节点的正文；进度、选择、平移不会重建输入会话。 */
export function usePromptSummary(
  contents: PromptContentModule | undefined,
  nodeKey: string,
): string {
  const subscribe = useCallback(
    (listener: () => void) => contents?.subscribe(nodeKey, listener) ?? (() => {}),
    [contents, nodeKey],
  );
  const snapshot = useCallback(() => contents?.read(nodeKey)?.plainText ?? "", [contents, nodeKey]);
  return useSyncExternalStore(subscribe, snapshot);
}

export function usePromptAttachmentCount(
  contents: PromptContentModule | undefined,
  nodeKey: string,
): number {
  const subscribe = useCallback(
    (listener: () => void) => contents?.subscribe(nodeKey, listener) ?? (() => {}),
    [contents, nodeKey],
  );
  const snapshot = useCallback(
    () => contents?.read(nodeKey)?.attachmentCount ?? 0,
    [contents, nodeKey],
  );
  return useSyncExternalStore(subscribe, snapshot);
}
