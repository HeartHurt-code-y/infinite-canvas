import { useCallback, useMemo, useSyncExternalStore } from "react";
import type { PromptContentModule } from "../../lib/promptContent";
import { seedanceTaskInputs } from "../../lib/seedanceTasks";

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

/** Only attachment identity and media type affect task controls; typing does not rebuild them. */
export function usePromptAttachmentInputs(
  contents: PromptContentModule | undefined,
  nodeKey: string,
): ReturnType<typeof seedanceTaskInputs> {
  const subscribe = useCallback(
    (listener: () => void) => contents?.subscribe(nodeKey, listener) ?? (() => {}),
    [contents, nodeKey],
  );
  const snapshot = useCallback(
    () => JSON.stringify(seedanceTaskInputs([], contents?.read(nodeKey)?.document)),
    [contents, nodeKey],
  );
  const token = useSyncExternalStore(subscribe, snapshot);
  return useMemo(() => JSON.parse(token) as ReturnType<typeof seedanceTaskInputs>, [token]);
}
