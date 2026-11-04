import { generationClient, type GenerationTaskPage, type GenerationTaskSummary } from "../../lib/backend";
import { isTerminalTaskStatus } from "./workspaceModel";

/**
 * A busy canvas can have more active tasks than its recent-history page.
 * Keep active tasks paginated separately and retain summaries owned by saved nodes.
 */
export async function loadCanvasGenerationTasks(
  canvasId: string,
  previous: GenerationTaskPage | undefined,
  ownedTaskIds: ReadonlySet<string>,
  signal: AbortSignal,
): Promise<GenerationTaskPage> {
  const [recent, firstActive] = await Promise.all([
    generationClient.list({ canvasId, limit: 50 }),
    generationClient.list({ canvasId, statuses: ["created", "submitting", "retry_wait", "queued", "running"], limit: 100 }),
  ]);
  signal.throwIfAborted();
  const summaries = new Map<string, GenerationTaskSummary>();
  for (const task of previous?.items ?? []) {
    if (ownedTaskIds.has(task.id)) summaries.set(task.id, task);
  }
  for (const task of recent.items) summaries.set(task.id, task);
  const returnedIds = new Set(recent.items.map(task => task.id));
  let page = firstActive;
  for (;;) {
    for (const task of page.items) {
      summaries.set(task.id, task);
      returnedIds.add(task.id);
    }
    if (!page.nextCursor) break;
    page = await generationClient.list({
      canvasId, statuses: ["created", "submitting", "retry_wait", "queued", "running"], limit: 100, cursor: page.nextCursor,
    });
    signal.throwIfAborted();
  }
  const unresolved = [...ownedTaskIds].filter(id => {
    const known = summaries.get(id);
    return !known || (!returnedIds.has(id) && !isTerminalTaskStatus(known.status));
  });
  // Only task summaries that fell outside the history window need a direct read.
  // Bound IPC fan-out when opening an older canvas with many saved results.
  const queue = unresolved.values();
  await Promise.all(Array.from({ length: Math.min(4, unresolved.length) }, async () => {
    for (const id of queue) {
      signal.throwIfAborted();
      try {
        const task = (await generationClient.getProgress(id)).summary;
        if (task.canvasId === canvasId) summaries.set(task.id, task);
      } catch {
        signal.throwIfAborted();
        // Existing cards retain their last known state when this read fails.
      }
    }
  }));
  return { items: [...summaries.values()].sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id)),
    nextCursor: recent.nextCursor };
}
