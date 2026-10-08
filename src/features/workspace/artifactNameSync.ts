import type { OutputNodeData } from "./workspaceModel";

/** Published only after any authoritative result-name write has succeeded. */
export interface ArtifactNameChange {
  readonly taskId: string;
  readonly finalPath: string;
  readonly resultIndex?: number;
  readonly name: string;
}

type PatchOutputs = (update: (node: OutputNodeData) => OutputNodeData) => number;

/** Paths are delivery identities, never renamed when the display label changes. */
function comparablePath(path: string): string {
  if (/^[a-z]:[\\/]/i.test(path) || path.startsWith("\\\\") || path.startsWith("//")) {
    return path
      .replace(/^\\\\\?\\/, "")
      .replaceAll("\\", "/")
      .toLowerCase();
  }
  return path;
}

export function artifactNameChangeMatches(
  node: Pick<OutputNodeData, "taskId" | "finalPath">,
  change: ArtifactNameChange,
): boolean {
  return (
    node.taskId === change.taskId &&
    node.finalPath != null &&
    comparablePath(node.finalPath) === comparablePath(change.finalPath)
  );
}

export function applyArtifactNameChange(
  node: OutputNodeData,
  change: ArtifactNameChange,
): OutputNodeData {
  if (
    !artifactNameChangeMatches(node, change) ||
    (node.name === change.name && node.customName === change.name)
  ) {
    return node;
  }
  return { ...node, name: change.name, customName: change.name };
}

/**
 * All visited canvases stay mounted, with independent stores. Register each hydrated
 * store once; retain the latest names so a slow-loading canvas receives changes too.
 */
export function createArtifactNameSync() {
  const stores = new Set<PatchOutputs>();
  const listeners = new Set<(change: ArtifactNameChange) => void>();
  const latest = new Map<string, ArtifactNameChange>();

  const register = (patch: PatchOutputs): (() => void) => {
    stores.add(patch);
    patch((node) => {
      const change =
        node.finalPath == null
          ? undefined
          : latest.get(JSON.stringify([node.taskId, comparablePath(node.finalPath)]));
      return change ? applyArtifactNameChange(node, change) : node;
    });
    return () => {
      stores.delete(patch);
      if (stores.size === 0) latest.clear();
    };
  };

  const publish = (change: ArtifactNameChange): number => {
    if (!change.taskId || !change.finalPath || !change.name.trim()) {
      throw new Error("产物名称同步缺少稳定的任务、文件或名称。");
    }
    latest.set(JSON.stringify([change.taskId, comparablePath(change.finalPath)]), change);
    let patched = 0;
    for (const patch of stores) patched += patch((node) => applyArtifactNameChange(node, change));
    for (const listener of listeners) listener(change);
    return patched;
  };

  const subscribe = (listener: (change: ArtifactNameChange) => void): (() => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  const resolve = (node: OutputNodeData): OutputNodeData => {
    const change =
      node.finalPath == null
        ? undefined
        : latest.get(JSON.stringify([node.taskId, comparablePath(node.finalPath)]));
    return change ? applyArtifactNameChange(node, change) : node;
  };

  const currentName = (taskId: string, finalPath: string): string | null =>
    latest.get(JSON.stringify([taskId, comparablePath(finalPath)]))?.name ?? null;

  return { register, publish, subscribe, resolve, currentName };
}

const artifactNameSync = createArtifactNameSync();
export const registerArtifactNameSync = artifactNameSync.register;
export const publishArtifactNameChange = artifactNameSync.publish;
export const subscribeArtifactNameChanges = artifactNameSync.subscribe;
export const resolveCurrentArtifactName = artifactNameSync.resolve;
export const currentArtifactDisplayName = artifactNameSync.currentName;
