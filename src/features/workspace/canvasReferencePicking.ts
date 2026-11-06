import { createContext, useCallback, useLayoutEffect, useMemo, useState, type RefObject } from "react";
import { useStore } from "zustand";
import { useEscapeHandler } from "../../components/escapeArbiter";
import { canvasReadModelOfState, isSupportedConnection, planCanvasConnection, type CanvasNodeEntry, type CanvasStore } from "../canvas/canvasStore";
import { promptContentReferenceCandidates, type PromptContentMediaReferenceItem, type PromptContentModule } from "../../lib/promptContent";
import { buildReferenceCatalog, candidateTarget, createPromptReference, type PromptReferenceCandidate } from "../../lib/promptReferences";
import { sameMediaReferenceTarget, sameMediaSourceIdentity } from "../../lib/promptReferenceTarget";
import { imageNodePreview } from "./imageNodeResults";
import { assetGenerationInput, outputGenerationInput, generationInputMentionCandidate, cloudAssetAwaitingId, outputNodeReferenceTarget, type AssetItem, type AssetKind, type OutputNodeData } from "./workspaceModel";

export interface CanvasReferenceSession {
  readonly targetKey: string;
  readonly restoreFocus: () => void;
  readonly onError: (error: string | null) => void;
  readonly addAsset: (asset: AssetItem) => boolean;
}

export const CanvasReferencePickingContext = createContext<{
  readonly session: CanvasReferenceSession | null;
  readonly setSession: (session: CanvasReferenceSession | null) => void;
  readonly readMentionSources: (targetKey: string) => readonly PromptReferenceCandidate[];
  readonly connectMention: (targetKey: string, source: PromptReferenceCandidate) => readonly PromptReferenceCandidate[];
  readonly replaceMention: (
    targetKey: string,
    previous: PromptContentMediaReferenceItem,
    source: PromptReferenceCandidate,
  ) => readonly PromptReferenceCandidate[];
} | null>(null);

type Choice = { readonly sourceKey: string; readonly edgeIds: readonly string[] };
type State = Pick<ReturnType<CanvasStore["getState"]>, "nodesById" | "assetEdges">;

export function acceptsReferenceMedia(target: CanvasNodeEntry | undefined, kind: AssetKind): boolean {
  return target?.type === "videoClip" || (target?.type === "gen" &&
    (target.data.kind === "video" || target.data.kind === kind || (target.data.kind === "prompt" && kind === "image")));
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
  promptContents: PromptContentModule,
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

  const readMentionSources = useCallback((targetKey: string) => {
    const state = store.getState();
    const model = canvasReadModelOfState(state);
    const candidates: PromptReferenceCandidate[] = [];
    const seen = new Set<string>();
    for (const [key, choice] of choicesFor(state, targetKey)) {
      const entry = state.nodesById[key];
      if (!entry) continue;
      let input = entry.type === "asset" ? assetGenerationInput(entry.data)
        : entry.type === "output" ? outputGenerationInput(entry.data) : null;
      if (entry.type === "gen") {
        const output = entry.data.kind === "image" ? imageNodePreview(entry.data) ?? model.nodes.output.filter(output => output.sourceNodeId === key && output.mediaType === "image").at(-1)
          : model.nodes.output.find(output => output.key === choice.sourceKey);
        if (output) input = outputGenerationInput(output);
      }
      if (!input || seen.has(choice.sourceKey)) continue;
      seen.add(choice.sourceKey);
      candidates.push(generationInputMentionCandidate({ ...input, key: choice.sourceKey,
        target: { ...input.target, canvasNodeKey: choice.sourceKey } }));
    }
    return candidates;
  }, [store]);
  const connectMention = useCallback((targetKey: string, source: PromptReferenceCandidate) => {
    const current = readMentionSources(targetKey).find(item => item.canvasNodeKey === source.canvasNodeKey);
    if (!current || !sameMediaReferenceTarget(candidateTarget(current), candidateTarget(source))) {
      throw new Error("素材已变化，请重新选择。");
    }
    const result = store.getState().connect(current.canvasNodeKey, targetKey);
    if (result.status === "rejected") throw new Error("这份素材暂时不能连接到当前节点。");
    return canvasReadModelOfState(store.getState()).resolveInputs(targetKey).media.map(generationInputMentionCandidate);
  }, [readMentionSources, store]);
  const replaceMention = useCallback((targetKey: string, previous: PromptContentMediaReferenceItem, source: PromptReferenceCandidate) => {
    if (editorKey !== targetKey) throw new Error("当前节点已切换，请重新选择素材。");
    const before = promptContents.snapshotAll();
    const document = before[targetKey];
    const current = document?.items.find(item => item.kind === "media_reference" && item.mentionId === previous.mentionId);
    if (!document || current?.kind !== "media_reference" || current.canvasNodeKey !== previous.canvasNodeKey ||
        !sameMediaReferenceTarget(current.target, previous.target)) {
      throw new Error("原引用已变化，请重新打开替换菜单。");
    }

    const state = store.getState();
    const inputs = canvasReadModelOfState(state).resolveInputs(targetKey).media;
    const attachments = document.items.filter(item => item.kind === "attachment");
    const sourceTarget = candidateTarget(source);
    let candidates = promptContentReferenceCandidates(inputs.map(generationInputMentionCandidate), attachments);
    let replacement = candidates.find(item => item.canvasNodeKey === source.canvasNodeKey);
    if (replacement && !sameMediaReferenceTarget(candidateTarget(replacement), sourceTarget)) {
      throw new Error("素材已变化，请重新选择。");
    }
    if (replacement?.canvasNodeKey === current.canvasNodeKey && sameMediaReferenceTarget(current.target, sourceTarget)) {
      return candidates;
    }

    let graph: Pick<State, "nodesById" | "assetEdges"> & { readonly selectedEdgeId: string | null } = state;
    let replaceAllOccurrences = false;
    if (!replacement) {
      const liveSource = readMentionSources(targetKey).find(item => item.canvasNodeKey === source.canvasNodeKey);
      if (!liveSource || !sameMediaReferenceTarget(candidateTarget(liveSource), sourceTarget)) {
        throw new Error("素材已变化，请重新选择。");
      }
      const oldInput = inputs.find(input => input.key === current.canvasNodeKey && sameMediaReferenceTarget(input.target, current.target));
      // Only exchange a direct edge that contributes exactly the reference being replaced.
      const oldEdge = oldInput?.kind === liveSource.kind && inputs.filter(input => input.edgeId === oldInput.edgeId).length === 1
        ? state.assetEdges.find(edge => edge.id === oldInput.edgeId && edge.toKey === targetKey && edge.fromKey === current.canvasNodeKey)
        : undefined;
      const plan = planCanvasConnection(state, liveSource.canvasNodeKey, targetKey, oldEdge);
      if (plan.result.status === "rejected") throw new Error("这份素材暂时不能连接到当前节点。");
      graph = plan.graph;
      const projected = canvasReadModelOfState({ ...state, ...graph }).resolveInputs(targetKey).media;
      const edgeId = plan.result.status === "connected" ? plan.result.edge.id : plan.result.edgeId;
      const nextInput = projected.find(input => input.edgeId === edgeId && sameMediaSourceIdentity(input.target, sourceTarget));
      if (!nextInput) throw new Error("所选素材尚未就绪，请重新选择。");
      candidates = promptContentReferenceCandidates(projected.map(generationInputMentionCandidate), attachments);
      replacement = candidates.find(item => item.canvasNodeKey === nextInput.key);
      replaceAllOccurrences = plan.result.status === "connected" && plan.result.replacedEdgeIds.length > 0;
    }
    if (!replacement) throw new Error("所选素材尚未就绪，请重新选择。");

    const alias = buildReferenceCatalog(candidates).aliases[candidates.indexOf(replacement)]!.label;
    const reference = createPromptReference(replacement, { alias });
    const items = document.items.map(item => {
      if (item.kind !== "media_reference") return item;
      const matchesOld = item.canvasNodeKey === current.canvasNodeKey && sameMediaReferenceTarget(item.target, current.target);
      if (item.mentionId !== current.mentionId && !(replaceAllOccurrences && matchesOld)) return item;
      return {
        ...reference,
        mentionId: item.mentionId,
        ...(item.block === undefined ? {} : { block: item.block }),
        ...(item.indent === undefined ? {} : { indent: item.indent }),
        ...(item.trailing === undefined ? {} : { trailing: item.trailing }),
      };
    });
    state.setPromptDocuments(before);
    state.commitPromptReferenceChange(graph, { ...before, [targetKey]: { ...document, items } });
    return candidates;
  }, [editorKey, promptContents, readMentionSources, store]);
  const context = useMemo(() => ({ session, setSession, readMentionSources, connectMention, replaceMention }),
    [session, readMentionSources, connectMention, replaceMention]);
  return { context, session, selectedByNode, acceptsAsset, assetOrder, stop, toggleNodes, toggleAsset };
}
