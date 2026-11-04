import { createContext, useCallback, useLayoutEffect, useMemo, useState, type RefObject } from "react";
import { useStore } from "zustand";
import { useEscapeHandler } from "../../components/escapeArbiter";
import { isSupportedConnection, type CanvasNodeEntry, type CanvasStore } from "../canvas/canvasStore";
import { imageNodePreview } from "./imageNodeResults";
import { cloudAssetAwaitingId, outputNodeReferenceTarget, type AssetItem, type AssetKind, type OutputNodeData } from "./workspaceModel";

export interface CanvasReferenceSession {
  readonly targetKey: string;
  readonly restoreFocus: () => void;
  readonly onError: (error: string | null) => void;
  readonly addAsset: (asset: AssetItem) => boolean;
}

export const CanvasReferencePickingContext = createContext<{
  readonly session: CanvasReferenceSession | null;
  readonly setSession: (session: CanvasReferenceSession | null) => void;
} | null>(null);

type Choice = { readonly sourceKey: string; readonly edgeIds: readonly string[] };
type State = Pick<ReturnType<CanvasStore["getState"]>, "nodesById" | "assetEdges">;

export function acceptsReferenceMedia(target: CanvasNodeEntry | undefined, kind: AssetKind): boolean {
  return target?.type === "videoClip" || (target?.type === "gen" &&
    (target.data.kind === "video" || target.data.kind === kind));
}

function choicesFor(state: State, targetKey: string): ReadonlyMap<string, Choice> {
  const choices = new Map<string, Choice>();
  const target = state.nodesById[targetKey];
  if (!target) return choices;
  const incoming = new Map<string, string[]>();
  for (const edge of state.assetEdges) {
    if (edge.toKey !== targetKey) continue;
    const ids = incoming.get(edge.fromKey) ?? [];
    ids.push(edge.id);
    incoming.set(edge.fromKey, ids);
  }
  const nodes = Object.values(state.nodesById);
  const latest = new Map<string, OutputNodeData>();
  for (const entry of nodes) {
    if (entry.type === "output" && entry.data.mediaType !== "text" && (entry.data.finalPath || entry.data.previewSrc)) {
      latest.set(entry.data.sourceNodeId, entry.data);
    }
  }
  for (const entry of nodes) {
    const key = entry.data.key;
    if (key === targetKey) continue;
    let sourceKey = key;
    let output: OutputNodeData | null | undefined;
    if (entry.type === "asset") {
      if (entry.data.libraryResource || !acceptsReferenceMedia(target, entry.data.kind)) continue;
    } else if (entry.type === "output") {
      output = entry.data;
    } else if (entry.type === "gen" && entry.data.kind === "image" && entry.data.imageGeneration) {
      output = imageNodePreview(entry.data);
      if (!output) continue;
    } else if (entry.type === "gen" && (entry.data.kind === "image" || entry.data.kind === "video" || entry.data.kind === "audio")) {
      output = latest.get(key);
      if (!output) continue;
      if (entry.data.kind !== "image") sourceKey = output.key;
    } else {
      if (target.type === "gen" && target.data.kind === "audio") continue;
      const text = entry.type === "gen" && entry.data.kind === "prompt" ? entry.data.config.generatedPrompt
        : entry.type === "screenplay" ? entry.data.config.currentDocument : "";
      if (!text.trim()) continue;
    }
    if (output && (output.mediaType === "text" || !acceptsReferenceMedia(target, output.mediaType) || !outputNodeReferenceTarget(output))) continue;
    const source = state.nodesById[sourceKey];
    if (!source || !isSupportedConnection(source, target)) continue;
    const edgeIds = new Set(incoming.get(sourceKey));
    // Older canvases may connect the result card instead of its image node.
    if (output && output.key !== sourceKey) {
      for (const id of incoming.get(output.key) ?? []) edgeIds.add(id);
    }
    if (key !== sourceKey) for (const id of incoming.get(key) ?? []) edgeIds.add(id);
    choices.set(key, { sourceKey, edgeIds: [...edgeIds] });
  }
  return choices;
}

function representsAsset(entry: CanvasNodeEntry | undefined, asset: AssetItem): boolean {
  if (entry?.type !== "asset" || entry.data.libraryResource) return false;
  const node = entry.data;
  const source = asset.source ?? "cloud";
  return node.assetId === asset.id && node.kind === asset.kind && (node.source ?? "cloud") === source &&
    (source === "local" || node.providerConnectionId === asset.providerConnectionId);
}

export function useCanvasReferencePicking(
  store: CanvasStore,
  viewport: RefObject<HTMLDivElement | null>,
  editorKey: string | null,
) {
  const [requestedSession, setSession] = useState<CanvasReferenceSession | null>(null);
  const session = requestedSession?.targetKey === editorKey ? requestedSession : null;
  const targetKey = session?.targetKey;
  const nodesById = useStore(store, state => targetKey ? state.nodesById : null);
  const assetEdges = useStore(store, state => targetKey ? state.assetEdges : null);
  const choices = useMemo(() => targetKey && nodesById && assetEdges ? choicesFor({ nodesById, assetEdges }, targetKey) : null,
    [targetKey, nodesById, assetEdges]);
  const selectedByNode = useMemo(() => choices && new Map([...choices].map(([key, choice]) => [key, choice.edgeIds.length > 0])), [choices]);
  const acceptsAsset = useCallback((asset: AssetItem) => {
    const target = targetKey ? store.getState().nodesById[targetKey] : undefined;
    return acceptsReferenceMedia(target, asset.kind) && !cloudAssetAwaitingId(asset)
      && asset.cloudStatus !== "failed" && asset.cloudStatus !== "deleted"
      && (asset.source === "local" || Boolean(asset.providerConnectionId));
  }, [store, targetKey]);
  const assetOrder = useCallback((asset: AssetItem) => {
    if (!targetKey || !nodesById || !assetEdges) return null;
    const incoming = assetEdges.filter(edge => edge.toKey === targetKey);
    const index = incoming.findIndex(edge => representsAsset(nodesById[edge.fromKey], asset));
    return index < 0 ? null : index + 1;
  }, [targetKey, nodesById, assetEdges]);

  useLayoutEffect(() => {
    if (requestedSession && !session) setSession(null);
  }, [requestedSession, session]);

  const stop = useCallback(() => {
    setSession(null);
    session?.restoreFocus();
  }, [session]);
  useEscapeHandler({ canHandle: () => session != null, handle: stop }, session != null);

  const toggleNodes = useCallback((keys: readonly string[]) => {
    if (!session) return;
    const state = store.getState();
    const available = choicesFor(state, session.targetKey);
    const selected = new Map<string, Choice>();
    for (const key of keys) {
      const choice = available.get(key);
      if (choice) selected.set(choice.sourceKey, choice);
    }
    if (selected.size === 0) return;
    const remove = [...selected.values()].every(choice => choice.edgeIds.length > 0);
    let rejected = false;
    state.runWithCoalescedHistory(() => {
      for (const choice of selected.values()) {
        if (remove) {
          for (const id of choice.edgeIds) state.disconnect(id);
        } else if (!choice.edgeIds.length) {
          rejected = state.connect(choice.sourceKey, session.targetKey).status === "rejected" || rejected;
        }
      }
    });
    session.onError(rejected ? "这份素材暂时不能连接，请换一份素材。" : null);
  }, [session, store]);

  const toggleAsset = useCallback((asset: AssetItem) => {
    if (!session || !acceptsAsset(asset)) return;
    const state = store.getState();
    const linked = state.assetEdges.filter(edge => edge.toKey === session.targetKey && representsAsset(state.nodesById[edge.fromKey], asset));
    try {
      if (linked.length) {
        state.runWithCoalescedHistory(() => linked.forEach(edge => state.disconnect(edge.id)));
      } else {
        const existing = Object.values(state.nodesById).find(entry => representsAsset(entry, asset));
        if (existing) {
          if (state.connect(existing.data.key, session.targetKey).status === "rejected") throw new Error("这份素材暂时不能连接。");
        } else if (!session.addAsset(asset)) {
          throw new Error("当前节点无法连接素材，请重新选择。");
        }
      }
      session.onError(null);
    } catch (error) {
      session.onError(error instanceof Error ? error.message : String(error));
    }
  }, [acceptsAsset, session, store]);

  useLayoutEffect(() => {
    const canvas = viewport.current;
    if (!canvas || !session) return;
    const nodeAt = (target: EventTarget | null) => target instanceof Element && canvas.contains(target)
      ? target.closest<HTMLElement>(".react-flow__node[data-id]")?.dataset["id"] : undefined;
    const pointerDown = (event: PointerEvent) => {
      if (event.button === 0 && nodeAt(event.target)) event.stopPropagation();
    };
    const click = (event: MouseEvent) => {
      const key = nodeAt(event.target);
      if (!key) return;
      event.preventDefault();
      event.stopPropagation();
      toggleNodes([key]);
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229 || event.defaultPrevented) return;
      const key = nodeAt(event.target);
      if (!key) return;
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        event.stopPropagation();
        if (!event.repeat) toggleNodes([key]);
      }
    };
    canvas.addEventListener("pointerdown", pointerDown, true);
    canvas.addEventListener("click", click, true);
    canvas.addEventListener("keydown", keydown, true);
    return () => {
      canvas.removeEventListener("pointerdown", pointerDown, true);
      canvas.removeEventListener("click", click, true);
      canvas.removeEventListener("keydown", keydown, true);
    };
  }, [session, toggleNodes, viewport]);

  useLayoutEffect(() => {
    const nodes = viewport.current?.querySelector(".react-flow__nodes");
    if (!nodes || !selectedByNode) return;
    const selector = ".react-flow__node[data-id]";
    const paint = () => {
      for (const element of nodes.querySelectorAll<HTMLElement>(selector)) {
        const key = element.dataset["id"] ?? "";
        const selected = selectedByNode.get(key);
        element.dataset["referenceState"] = key === targetKey ? "target"
          : selected === true ? "selected" : selected === false ? "available" : "unavailable";
      }
    };
    paint();
    const observer = new MutationObserver(paint);
    observer.observe(nodes, { childList: true });
    return () => {
      observer.disconnect();
      nodes.querySelectorAll<HTMLElement>(selector).forEach(element => delete element.dataset["referenceState"]);
    };
  }, [selectedByNode, targetKey, viewport]);

  const context = useMemo(() => ({ session, setSession }), [session]);
  return { context, session, selectedByNode, acceptsAsset, assetOrder, stop, toggleNodes, toggleAsset };
}
