import { createContext, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useStore } from "zustand";
import { ChevronDown, LoaderCircle, MousePointer2, Sparkles, X } from "lucide-react";
import { useEscapeHandler } from "../../components/escapeArbiter";
import { placeFloatingLayer } from "../../components/floatingLayer";
import { backendErrorMessage, promptNodeClient, type MediaReferenceTarget, type ProviderCatalogEntry } from "../../lib/backend";
import { imageMarkDescription, imageMarkRecognitionPrompt, parseImageMarkSuggestions, type ImageMark } from "../../lib/imageMarks";
import type { PromptContentEditorSession, PromptContentModule } from "../../lib/promptContent";
import { sameMediaReferenceTarget } from "../../lib/promptReferenceTarget";
import { toast } from "../../lib/toast";
import type { CanvasNodeEntry, CanvasStore } from "../canvas/canvasStore";
import { imageNodePreview } from "./imageNodeResults";
import { assetNodeReferenceTarget, outputNodeReferenceTarget, type NodeModelSelection } from "./workspaceModel";
import "./CanvasImageMarking.css";

interface MarkEditor {
  readonly targetKey: string;
  readonly sessionRef: RefObject<PromptContentEditorSession | null>;
  readonly restoreFocus: () => void;
}

export const CanvasImageMarkingContext = createContext<{
  readonly targetKey: string | null;
  readonly register: (editor: MarkEditor | null) => void;
  readonly start: () => void;
  readonly stop: () => void;
} | null>(null);

type ImageSource = { readonly key: string; readonly name: string; readonly target: MediaReferenceTarget };
type ImageRect = { readonly left: number; readonly top: number; readonly width: number; readonly height: number };
type PendingPoint = { readonly id: string; readonly source: ImageSource; readonly point: ImageMark["point"] };
const EMPTY_MARKS: readonly ImageMark[] = [];

function imageSource(entry: CanvasNodeEntry | undefined): ImageSource | null {
  if (entry?.type === "asset" && entry.data.kind === "image" && !entry.data.libraryResource)
    return { key: entry.data.key, name: entry.data.name, target: assetNodeReferenceTarget(entry.data) };
  const output = entry?.type === "output" && entry.data.mediaType === "image" ? entry.data
    : entry?.type === "gen" && entry.data.kind === "image" ? imageNodePreview(entry.data) : null;
  const target = output && outputNodeReferenceTarget(output);
  return output && target ? { key: entry!.data.key, name: output.name ?? "图片", target } : null;
}

function sourceImage(viewport: HTMLElement, key: string): HTMLImageElement | null {
  const node = [...viewport.querySelectorAll<HTMLElement>(".react-flow__node[data-id]")].find(node => node.dataset["id"] === key);
  if (!node) return null;
  // Media images only: tool icons, reference tiles and avatars are not markable.
  return node.querySelector<HTMLImageElement>(".canvas-node-preview__media img, img.canvas-node-preview__image, .canvas-asset-node__visual img, .canvas-node-preview img");
}

function imageRect(image: HTMLImageElement): ImageRect | null {
  const bounds = image.getBoundingClientRect();
  if (!image.isConnected || !image.naturalWidth || bounds.width <= 0 || bounds.height <= 0) return null;
  const fit = getComputedStyle(image).objectFit;
  if (fit !== "contain" && fit !== "scale-down") return bounds;
  const scale = Math.min(bounds.width / image.naturalWidth, bounds.height / image.naturalHeight, fit === "scale-down" ? 1 : Infinity);
  const width = image.naturalWidth * scale;
  const height = image.naturalHeight * scale;
  return { left: bounds.left + (bounds.width - width) / 2, top: bounds.top + (bounds.height - height) / 2, width, height };
}

function SuggestionMenu({ mark, anchor, onSelect, onClose }: {
  readonly mark: ImageMark;
  readonly anchor: HTMLElement;
  readonly onSelect: (index: number) => void;
  readonly onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ x: 0, y: 0, ready: false });
  useEscapeHandler({ canHandle: () => true, handle: onClose });
  useLayoutEffect(() => {
    const menu = ref.current;
    if (!menu) return;
    const measure = () => {
      if (!anchor.isConnected) { onClose(); return; }
      const placed = placeFloatingLayer(anchor, { minWidth: menu.offsetWidth, maxHeight: 208, measuredHeight: menu.offsetHeight,
        preferAbove: false, gap: 4, margin: 8 });
      setPosition({ x: placed.left, y: placed.top, ready: true });
    };
    measure();
    const timer = window.setInterval(measure, 120);
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !menu.contains(event.target) && !anchor.contains(event.target)) onClose(); };
    document.addEventListener("pointerdown", outside, true);
    return () => { window.clearInterval(timer); document.removeEventListener("pointerdown", outside, true); };
  }, [anchor, onClose]);
  return createPortal(<div ref={ref} className="canvas-image-mark-menu nodrag nopan nowheel" role="menu" aria-label="切换局部元素"
    style={{ transform: `translate(${position.x}px, ${position.y}px)`, visibility: position.ready ? "visible" : "hidden" }}
    onKeyDown={event => {
      if (event.nativeEvent.isComposing || event.keyCode === 229) return;
      const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button")];
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === "ArrowDown" ? (index + 1) % buttons.length : event.key === "ArrowUp" ? (index - 1 + buttons.length) % buttons.length
        : event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : null;
      if (next != null) { event.preventDefault(); event.stopPropagation(); buttons[next]?.focus(); }
    }}>
    {mark.suggestions.map((suggestion, index) => <button key={index} type="button" role="menuitemradio" aria-checked={index === mark.selectedIndex}
      autoFocus={index === mark.selectedIndex} onClick={() => onSelect(index)}><span>{suggestion.label}</span>{index === mark.selectedIndex ? <i aria-hidden="true" /> : null}</button>)}
  </div>, document.body);
}

function ImageMarkOverlay({ viewport, store, mark, pending, onMenu, onDelete }: {
  readonly viewport: RefObject<HTMLDivElement | null>;
  readonly store: CanvasStore;
  readonly mark?: ImageMark;
  readonly pending?: PendingPoint;
  readonly onMenu: (mark: ImageMark, anchor: HTMLElement) => void;
  readonly onDelete: (mark: ImageMark) => void;
}) {
  const [rect, setRect] = useState<ImageRect | null>(null);
  const sourceKey = mark?.sourceKey ?? pending!.source.key;
  const target = mark?.sourceTarget ?? pending!.source.target;
  useLayoutEffect(() => {
    const measure = () => {
      const element = viewport.current && sourceImage(viewport.current, sourceKey);
      const source = imageSource(store.getState().nodesById[sourceKey]);
      const next = element && source && sameMediaReferenceTarget(source.target, target) ? imageRect(element) : null;
      setRect(previous => previous?.left === next?.left && previous?.top === next?.top && previous?.width === next?.width && previous?.height === next?.height ? previous : next);
    };
    measure();
    const timer = window.setInterval(measure, 120);
    return () => window.clearInterval(timer);
  }, [sourceKey, store, target, viewport]);
  if (!rect) return null;
  const point = mark?.point ?? pending!.point;
  const suggestion = mark && (mark.suggestions[mark.selectedIndex] ?? mark.suggestions[0]);
  return createPortal(<div className="canvas-image-mark-overlay" style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}>
    {suggestion ? <div className="canvas-image-mark-overlay__box" style={{ left: `${suggestion.bbox.x * 100}%`, top: `${suggestion.bbox.y * 100}%`, width: `${suggestion.bbox.width * 100}%`, height: `${suggestion.bbox.height * 100}%` }} /> : null}
    <div className={`canvas-image-mark-overlay__label${pending ? " is-loading" : ""}`} style={{ left: `${point.x * 100}%`, top: `${point.y * 100}%` }}>
      {pending ? <span role="status"><LoaderCircle size={14} className="spin-icon" />分析中...</span> : mark ? <>
        <button type="button" aria-label={`局部元素：${suggestion?.label}`} aria-haspopup={mark.suggestions.length > 1 ? "menu" : undefined}
          onClick={event => { if (mark.suggestions.length > 1) onMenu(mark, event.currentTarget); }}><Sparkles size={14} /><span>{suggestion?.label}</span>{mark.suggestions.length > 1 ? <ChevronDown size={14} /> : null}</button>
        <button type="button" className="canvas-image-mark-overlay__delete" aria-label={`删除标记：${suggestion?.label}`} data-tooltip="删除标记" onClick={() => onDelete(mark)}><X size={12} /></button>
      </> : null}
    </div>
  </div>, document.body);
}

export function useCanvasImageMarking({ store, viewport, editorKey, canvasId, providerCatalog, defaultModel, promptContents }: {
  readonly store: CanvasStore;
  readonly viewport: RefObject<HTMLDivElement | null>;
  readonly editorKey: string | null;
  readonly canvasId: string;
  readonly providerCatalog: readonly ProviderCatalogEntry[];
  readonly defaultModel: NodeModelSelection;
  readonly promptContents: PromptContentModule;
}) {
  const editor = useRef<MarkEditor | null>(null);
  const insertAtCursor = useRef(false);
  const [requestedKey, setRequestedKey] = useState<string | null>(null);
  const targetKey = requestedKey === editorKey ? requestedKey : null;
  const [pending, setPending] = useState<PendingPoint | null>(null);
  const busy = useRef(false);
  const operation = useRef(0);
  const [menu, setMenu] = useState<{ id: string; anchor: HTMLElement } | null>(null);
  const entry = useStore(store, state => editorKey ? state.nodesById[editorKey] : undefined);
  const modelSelection = entry?.type === "gen" && entry.data.kind === "image" ? entry.data.config.markModelSelection ?? defaultModel : defaultModel;
  // read() builds a presentation document. Subscribe to a stable scalar instead
  // of returning a fresh document object on each React snapshot read.
  const referencedMarkIds = useSyncExternalStore(
    useCallback(listener => editorKey ? promptContents.subscribe(editorKey, listener) : () => {}, [editorKey, promptContents]),
    useCallback(() => editorKey ? promptContents.read(editorKey)?.document.items.flatMap(item => item.kind === "mark_reference" ? [item.markId] : []).join("\0") ?? "" : "", [editorKey, promptContents]),
  );
  const marks = useMemo(() => {
    const referenced = new Set(referencedMarkIds.split("\0"));
    return entry?.type === "gen" && entry.data.kind === "image"
      ? (entry.data.config.imageMarks ?? EMPTY_MARKS).filter(mark => referenced.has(mark.id)) : EMPTY_MARKS;
  }, [entry, referencedMarkIds]);
  const register = useCallback((value: MarkEditor | null) => { editor.current = value; }, []);
  const stop = useCallback(() => {
    operation.current += 1;
    busy.current = false;
    setRequestedKey(null);
    setPending(null);
    setMenu(null);
    editor.current?.restoreFocus();
  }, []);
  const closeMenu = useCallback(() => setMenu(null), []);
  const openMenu = useCallback((mark: ImageMark, anchor: HTMLElement) => setMenu({ id: mark.id, anchor }), []);
  const start = useCallback(() => {
    if (!editor.current) return;
    setRequestedKey(editor.current.targetKey);
  }, []);
  useEscapeHandler({ canHandle: () => targetKey != null && menu == null, handle: stop }, targetKey != null);
  useEffect(() => {
    if (requestedKey && !targetKey) stop();
  }, [requestedKey, targetKey, stop]);
  useEffect(() => () => { operation.current += 1; }, []);
  useEffect(() => {
    insertAtCursor.current = false;
    const rememberCaret = (event: Event) => {
      const input = event.target instanceof Element ? event.target.closest<HTMLElement>(".canvas-gen-node__prompt-input [contenteditable='true']") : null;
      if (input?.closest<HTMLElement>("[data-node-key]")?.dataset["nodeKey"] === editorKey) insertAtCursor.current = true;
    };
    document.addEventListener("pointerdown", rememberCaret, true);
    document.addEventListener("focusin", rememberCaret, true);
    document.addEventListener("keydown", rememberCaret, true);
    return () => {
      document.removeEventListener("pointerdown", rememberCaret, true);
      document.removeEventListener("focusin", rememberCaret, true);
      document.removeEventListener("keydown", rememberCaret, true);
    };
  }, [editorKey]);

  const patchMarks = useCallback((update: (marks: readonly ImageMark[]) => readonly ImageMark[]) => {
    if (!editorKey) return;
    store.getState().patchNode("gen", editorKey, node => node.kind === "image"
      ? { ...node, config: { ...node.config, imageMarks: update(node.config.imageMarks ?? EMPTY_MARKS) } } : node);
  }, [editorKey, store]);
  const remove = useCallback((mark: ImageMark) => {
    const session = editor.current?.sessionRef.current;
    if (!session || session.isComposing()) return;
    session.removeMarkReferences([mark.id]);
    patchMarks(marks => marks.filter(item => item.id !== mark.id));
    setMenu(null);
  }, [patchMarks]);
  const selectSuggestion = (mark: ImageMark, index: number) => {
    const session = editor.current?.sessionRef.current;
    if (!session || session.isComposing() || !mark.suggestions[index]) return;
    const updated = { ...mark, selectedIndex: index };
    const snapshot = session.snapshot();
    session.restore({ ...snapshot, items: snapshot.items.map(item => item.kind === "mark_reference" && item.markId === mark.id
      ? { ...item, labelSnapshot: updated.suggestions[index]!.label, descriptionSnapshot: imageMarkDescription(updated) } : item) });
    patchMarks(marks => marks.map(item => item.id === mark.id ? updated : item));
    setMenu(null);
  };

  useEffect(() => {
    const canvas = viewport.current;
    if (!canvas || !editorKey) return;
    const chipClick = (event: MouseEvent) => {
      const element = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-mark-id]") : null;
      const mark = element && marks.find(mark => mark.id === element.dataset["markId"]);
      if (!element || !mark) return;
      event.preventDefault();
      event.stopPropagation();
      setMenu({ id: mark.id, anchor: element });
    };
    const chipKey = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229 || event.defaultPrevented || !["Enter", " "].includes(event.key)) return;
      const element = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-mark-id]") : null;
      const mark = element && marks.find(mark => mark.id === element.dataset["markId"]);
      if (!element || !mark) return;
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) setMenu({ id: mark.id, anchor: element });
    };
    canvas.addEventListener("click", chipClick, true);
    canvas.addEventListener("keydown", chipKey, true);
    return () => { canvas.removeEventListener("click", chipClick, true); canvas.removeEventListener("keydown", chipKey, true); };
  }, [editorKey, marks, viewport]);

  useEffect(() => {
    const canvas = viewport.current;
    if (!canvas || !targetKey) return;
    const pick = (event: Event): { image: HTMLImageElement; source: ImageSource } | null => {
      const node = event.target instanceof Element ? event.target.closest<HTMLElement>(".react-flow__node[data-id]") : null;
      const key = node?.dataset["id"];
      if (!key) return null;
      const source = imageSource(store.getState().nodesById[key]);
      const image = source && sourceImage(canvas, key);
      return image && source && image.naturalWidth ? { image, source } : null;
    };
    const recognize = async (source: ImageSource, point: ImageMark["point"]) => {
      if (busy.current || !editor.current?.sessionRef.current || editor.current.sessionRef.current.isComposing()) return;
      const available = providerCatalog.filter(entry => entry.provider.enabled).flatMap(entry => entry.models
        .filter(model => model.operations.includes("text_generation")).map(model => ({ providerId: entry.provider.id, modelId: model.definitionId })));
      const selected = available.find(model => model.providerId === modelSelection.providerId && model.modelId === modelSelection.modelDefinitionId);
      if (!selected) { toast.error("请在图片节点的高级设置中选择可理解图片的元素识别模型。"); return; }
      const currentEditor = editor.current;
      const append = !insertAtCursor.current;
      const token = ++operation.current;
      busy.current = true;
      const id = `image-mark-${crypto.randomUUID()}`;
      setPending({ id, source, point });
      try {
        const result = await promptNodeClient.run({ canvasId, sourceNodeId: `${targetKey}:image-mark`,
          providerConnectionId: selected.providerId, modelDefinitionId: selected.modelId,
          mode: "video_prompt", generalText: true, task: "generate", userPrompt: imageMarkRecognitionPrompt(point),
          visionImages: [{ target: source.target, displayName: source.name }] });
        if (token !== operation.current || editor.current !== currentEditor) return;
        const liveSource = imageSource(store.getState().nodesById[source.key]);
        if (!liveSource || !sameMediaReferenceTarget(liveSource.target, source.target)) throw new Error("原图片已更换，请重新标记。");
        const suggestions = parseImageMarkSuggestions(result.rawModelOutput || result.optimizedPrompt, point);
        if (source.key !== targetKey) {
          const connection = store.getState().connect(source.key, targetKey);
          if (connection.status === "rejected") throw new Error("这张图片暂时不能连接到当前节点，请换一张图片。");
        }
        const mark: ImageMark = { id, sourceKey: source.key, sourceName: source.name, sourceTarget: source.target, point, suggestions, selectedIndex: 0 };
        currentEditor.sessionRef.current?.insertMarkReference({ markId: id, label: suggestions[0]!.label, description: imageMarkDescription(mark), color: "#ffffff", append, padded: true });
        insertAtCursor.current = false;
        patchMarks(marks => [...marks, mark]);
      } catch (error) {
        if (token === operation.current) toast.error("未识别出任何内容，请重新尝试。", { description: backendErrorMessage(error), duration: 8000 });
      } finally { if (token === operation.current) { busy.current = false; setPending(null); } }
    };
    const down = (event: PointerEvent) => {
      if (event.button !== 0 || !pick(event)) return;
      event.preventDefault();
      event.stopPropagation();
    };
    const click = (event: MouseEvent) => {
      const choice = pick(event);
      if (!choice) return;
      event.preventDefault();
      event.stopPropagation();
      const bounds = imageRect(choice.image);
      if (!bounds || event.clientX < bounds.left || event.clientX > bounds.left + bounds.width || event.clientY < bounds.top || event.clientY > bounds.top + bounds.height) return;
      void recognize(choice.source, { x: (event.clientX - bounds.left) / bounds.width, y: (event.clientY - bounds.top) / bounds.height });
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229 || event.defaultPrevented || !["Enter", " "].includes(event.key) ||
        (event.target instanceof Element && event.target.closest("input, textarea, [contenteditable=true]"))) return;
      const choice = pick(event);
      if (!choice) return;
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) void recognize(choice.source, { x: .5, y: .5 });
    };
    canvas.addEventListener("pointerdown", down, true);
    canvas.addEventListener("click", click, true);
    canvas.addEventListener("keydown", keydown, true);
    return () => {
      canvas.removeEventListener("pointerdown", down, true);
      canvas.removeEventListener("click", click, true);
      canvas.removeEventListener("keydown", keydown, true);
    };
  }, [canvasId, modelSelection, patchMarks, providerCatalog, store, targetKey, viewport]);

  const context = useMemo(() => ({ targetKey, register, start, stop }), [targetKey, register, start, stop]);
  const menuMark = marks.find(mark => mark.id === menu?.id);
  const overlays = <>
    {targetKey ? marks.map(mark => <ImageMarkOverlay key={mark.id} viewport={viewport} store={store} mark={mark} onMenu={openMenu} onDelete={remove} />) : null}
    {targetKey && pending ? <ImageMarkOverlay key={pending.id} viewport={viewport} store={store} pending={pending} onMenu={openMenu} onDelete={remove} /> : null}
    {menu && menuMark ? <SuggestionMenu mark={menuMark} anchor={menu.anchor} onSelect={index => selectSuggestion(menuMark, index)} onClose={closeMenu} /> : null}
  </>;
  return { context, targetKey, stop, overlays };
}

export function CanvasImageMarkingBar({ onReturn, onExit }: { readonly onReturn: () => void; readonly onExit: () => void }) {
  return <div className="canvas-reference-pick-bar canvas-image-mark-bar" aria-label="元素选择模式">
    <div className="canvas-reference-pick-bar__message" role="status">
      <span className="canvas-reference-pick-bar__icon" aria-hidden="true"><MousePointer2 size={16} /></span>
      <span className="canvas-image-mark-bar__text"><strong>元素选择模式</strong><small>点击图片选择局部元素</small></span>
    </div>
    <div className="canvas-reference-pick-bar__actions">
      <button type="button" onClick={onReturn}>返回节点</button>
      <button type="button" aria-label="退出元素选择" data-tooltip="退出 · Esc" onClick={onExit}><X size={12} /></button>
    </div>
  </div>;
}
