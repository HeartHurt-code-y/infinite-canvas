import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { CanvasSelect } from "../../components/CanvasSelect";
import { copyTextToDesktopClipboard } from "./desktopActions";
import type { DirectorNodeData } from "../canvas/canvasStore";
import { LibTVMediaIcon, type LibTVMediaIconName } from "./LibTVMediaIcon";
import { directorBodies, directorCameras, directorLookAt, directorProps, isDirectorBody } from "./directorCatalog";
import { directorJointAngle, directorJointSections, directorPosePresets, type DirectorPose } from "./directorPose";
import { directorObject, transformAt, type DirectorObject, type DirectorObjectKind, type DirectorScene, type DirectorTransform } from "./directorScene";
import { createDirectorViewport, directorViewLabels, type DirectorTransformMode, type DirectorViewport } from "./directorViewport";
import { importDirectorModel, listDirectorModels, type DirectorModelRecord } from "./directorModelAsset";
import { CanvasDirectorImport, type DirectorReference } from "./CanvasDirectorImport";
import { mergeDirectorLayout, type DirectorImageModel, type DirectorImageRequest, type DirectorImportMode } from "./directorSceneImport";
import "./CanvasDirectorEditor.css";

export interface DirectorMediaCapture {
  readonly name: string;
  readonly blob: Blob;
  readonly kind: "image" | "video";
  readonly aspectRatio: number;
}

export interface DirectorMotionRequest {
  readonly cameraId: string;
  readonly prompt: string;
  readonly preview: string;
}

function encode(canvas: HTMLCanvasElement) {
  return new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("截图编码失败。")), "image/png"));
}

const ASSET_TABS = [["props", "道具"], ["people", "人物"], ["camera", "机位"], ["templates", "模板"]] as const;
const ASPECTS = ["16:9", "4:3", "1:1", "9:16", "21:9"] as const;
const TRANSFORMS = [["translate", "移动", "V"], ["rotate", "旋转", "R"], ["scale", "缩放", "F"]] as const;
const FIELDS = [["position", "位置"], ["rotation", "旋转"], ["scale", "缩放"]] as const;
const SHOT_COUNTS = [[1, "截图"], [4, "四方位截图"], [12, "十二方位截图"]] as const;

function assetIcon(kind: DirectorObjectKind): LibTVMediaIconName {
  if (kind === "camera") return "camera-video";
  if (isDirectorBody(kind) || kind === "model") return "perspnal-n";
  return "style-cube";
}

function directorError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") return error.message;
  return "导演台操作失败，请重试。";
}

export function CanvasDirectorEditor({ node, references, models: visionModels, defaultModel, generating, generationError, onClose, onChange, onPrompt, onGenerate,
  onMotion, onPick, onRecognize, onPanorama, onCapture, onUndo, onRedo }: {
  readonly node: DirectorNodeData;
  readonly references: readonly DirectorReference[];
  readonly models: readonly (DirectorImageModel & { readonly label: string })[];
  readonly defaultModel: DirectorImageModel;
  readonly generating: boolean;
  readonly generationError: string | null;
  readonly onClose: () => void;
  readonly onChange: (update: (scene: DirectorScene) => DirectorScene, options?: { coalesce?: boolean; clearPanorama?: boolean }) => void;
  readonly onPrompt: (key: string, value: string) => void;
  readonly onGenerate: (key: string) => void;
  readonly onRecognize: (key: string, request: DirectorImageRequest) => Promise<boolean> | undefined;
  readonly onMotion: (key: string, request: DirectorMotionRequest) => void;
  readonly onPick: (key: string) => void;
  readonly onPanorama: (key: string | null) => void;
  readonly onCapture: (media: readonly DirectorMediaCapture[], signal: AbortSignal) => Promise<void>;
  readonly onUndo: () => void;
  readonly onRedo: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const viewportHost = useRef<HTMLDivElement>(null);
  const viewport = useRef<DirectorViewport | null>(null);
  const actions = useRef({ onChange });
  const capture = useRef<AbortController | null>(null);
  const titleId = useId();
  const [tab, setTab] = useState<(typeof ASSET_TABS)[number][0]>("props");
  const [query, setQuery] = useState("");
  const [selectedId, select] = useState<string | null>(null);
  const [viewId, setView] = useState<string | null>(null);
  const [mode, setMode] = useState<DirectorTransformMode>("translate");
  const [snap, setSnap] = useState(false);
  const [guide, setGuide] = useState(false);
  const [help, setHelp] = useState(false);
  const [drawing, setDrawing] = useState(false);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [loop, setLoop] = useState(false);
  const [captureState, setCaptureState] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [motionPrompt, setMotionPrompt] = useState("");
  const [importTab, setImportTab] = useState<"image" | "json" | null>(null);
  const [models, setModels] = useState<readonly DirectorModelRecord[]>([]);
  const [available, setAvailable] = useState(false);
  const playFrom = useRef(0);
  const { scene } = node;
  const item = scene.objects.find(object => object.id === selectedId);
  const cameras = scene.objects.filter(object => object.kind === "camera");
  const activeCamera = cameras.find(camera => camera.id === viewId);
  const panorama = references.find(reference => reference.key === node.panoramaKey)?.previewUrl ?? null;
  const referenceUrls = useMemo(() => new Map(references.map(ref => [ref.key, ref.previewUrl])), [references]);
  const matches = (label: string) => label.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
  const shown = (tab === "people" ? directorBodies : tab === "props" ? directorProps : []).filter(([, label]) => matches(label));
  const shownModels = models.filter(model => model.category === tab && matches(model.name));
  const selectedFrames = scene.tracks.find(track => track.objectId === selectedId)?.keyframes ?? [];
  const locked = Boolean(captureState) || playing || generating || drawing;

  useEffect(() => { actions.current = { onChange }; }, [onChange]);
  useEffect(() => {
    const element = dialog.current;
    const host = viewportHost.current;
    const priorFocus = document.activeElement;
    element?.showModal();
    try {
      if (!host) throw new Error("找不到导演台视口。");
      viewport.current = createDirectorViewport(host, {
        select,
        commit: (id, transform) => actions.current.onChange(current => ({
          ...current, objects: current.objects.map(object => object.id === id ? { ...object, ...transform } : object),
        })),
        panoramaFailed: () => setError("参考图无法载入为全景背景。请检查素材是否仍可读取。"),
        modelFailed: name => setError(`无法读取场景素材「${name}」。`),
        contextLost: () => { setAvailable(false); setError("3D 视口连接已断开，请关闭并重新打开导演台。"); },
      });
      setAvailable(true);
    } catch (failure) {
      setError("无法打开本地 3D 视口。 " + directorError(failure));
    }
    return () => {
      capture.current?.abort();
      viewport.current?.dispose();
      viewport.current = null;
      element?.close();
      if (priorFocus instanceof HTMLElement && priorFocus.isConnected) priorFocus.focus({ preventScroll: true });
    };
  }, []);
  useEffect(() => { viewport.current?.update(scene, referenceUrls); }, [scene, referenceUrls]);
  useEffect(() => {
    let active = true;
    void listDirectorModels().then(result => { if (active) setModels(result); })
      .catch(failure => { if (active) setError(directorError(failure)); });
    return () => { active = false; };
  }, []);
  useEffect(() => { viewport.current?.select(item?.id ?? null); }, [item?.id]);
  useEffect(() => { viewport.current?.view(activeCamera?.id ?? null); }, [activeCamera?.id]);
  useEffect(() => { viewport.current?.setMode(mode, snap); }, [mode, snap]);
  useEffect(() => { viewport.current?.panorama(panorama); }, [panorama]);
  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    const started = performance.now();
    const advance = (at: number) => {
      const elapsed = playFrom.current + (at - started) / 1000;
      const next = loop ? elapsed % scene.duration : Math.min(elapsed, scene.duration);
      viewport.current?.setTime(next);
      setTime(next);
      if (!loop && elapsed >= scene.duration) setPlaying(false);
      else frame = requestAnimationFrame(advance);
    };
    frame = requestAnimationFrame(advance);
    return () => cancelAnimationFrame(frame);
  }, [playing, loop, scene.duration]);

  function edit(id: string, changes: Partial<DirectorObject>) {
    viewport.current?.setTime(null);
    onChange(current => ({ ...current, objects: current.objects.map(object => object.id === id ? { ...object, ...changes } : object) }));
  }

  function add(kind: DirectorObjectKind, changes?: Partial<DirectorObject>) {
    const object = { ...directorObject(kind, scene.objects.filter(item => kind === "camera" ? item.kind === "camera" : item.kind !== "camera").length),
      ...(kind === "camera" ? viewport.current?.cameraPose() : undefined), ...changes };
    onChange(current => current.objects.length >= 80 ? current : { ...current, objects: [...current.objects, object] });
    setView(null);
    select(object.id);
    setFrame(0);
  }

  function editPose(pose: DirectorPose, coalesce = false) {
    if (!item) return;
    viewport.current?.setTime(null);
    onChange(current => ({ ...current, objects: current.objects.map(object => object.id === item.id
      ? { ...object, jointAngles: pose } : object) }), { coalesce });
  }

  function remove() {
    if (!item) return;
    onChange(current => ({
      ...current, objects: current.objects.filter(object => object.id !== item.id),
      tracks: current.tracks.filter(track => track.objectId !== item.id),
    }));
    select(null);
  }

  function duplicate() {
    if (!item || scene.objects.length >= 80) return;
    const copy: DirectorObject = { ...item, id: crypto.randomUUID(), name: (item.name + " 副本").slice(0, 80),
      position: [item.position[0] + 0.5, item.position[1], item.position[2]] };
    onChange(current => ({ ...current, objects: [...current.objects, copy] }));
    select(copy.id);
  }

  function setFrame(next: number, preview = next !== 0) {
    setTime(next);
    viewport.current?.setTime(preview ? next : null);
  }

  function toggleKeyframe() {
    if (!item) return;
    const at = Math.round(time * 10) / 10;
    onChange(current => {
      const frames = current.tracks.find(track => track.objectId === item.id)?.keyframes ?? [];
      const keyframes = frames.some(frame => frame.time === at) ? frames.filter(frame => frame.time !== at)
        : [...frames, { time: at, position: item.position, rotation: item.rotation, scale: item.scale,
          jointAngles: isDirectorBody(item.kind) ? item.jointAngles ?? {} : undefined }].sort((a, b) => a.time - b.time);
      return { ...current, tracks: [...current.tracks.filter(track => track.objectId !== item.id),
        ...(keyframes.length ? [{ objectId: item.id, keyframes }] : [])] };
    });
  }

  function motionPath(shape: "line" | "ring" | "rectangle") {
    if (!item) return;
    const [x, y, z] = item.position;
    const points = shape === "line" ? [[0, 0], [0, -3]] :
      shape === "rectangle" ? [[0, 0], [3, 0], [3, -2], [0, -2], [0, 0]] :
      Array.from({ length: 17 }, (_, index) => [Math.sin(index / 8 * Math.PI) * 2, (Math.cos(index / 8 * Math.PI) - 1) * 2]);
    const keyframes = points.map(([dx, dz], index) => ({
      time: scene.duration * index / (points.length - 1),
      position: [x + dx!, y, z + dz!] as DirectorTransform["position"], rotation: item.rotation, scale: item.scale,
    }));
    onChange(current => ({ ...current, tracks: [...current.tracks.filter(track => track.objectId !== item.id), { objectId: item.id, keyframes }] }));
  }

  function startDrawing() {
    if (!item || !viewport.current) return;
    setError(null);
    setDrawing(true);
    setView(null);
    setFrame(0);
    viewport.current.view(null);
    viewport.current.reset("top");
    viewport.current.beginPath();
  }

  function finishDrawing(save: boolean) {
    setDrawing(false);
    const path = viewport.current?.endPath();
    if (!save || !item || !path) return;
    if (path.length < 2) { setError("请在视口内按住鼠标左键画出一段路径。"); return; }
    const keyframes = path.map(([x, , z], index) => ({
      time: scene.duration * index / (path.length - 1),
      position: [x, item.position[1], z] as DirectorTransform["position"],
      rotation: item.rotation, scale: item.scale,
    }));
    onChange(current => ({ ...current, tracks: [...current.tracks.filter(track => track.objectId !== item.id), { objectId: item.id, keyframes }] }));
  }

  async function importModel(file: File, category: DirectorModelRecord["category"]) {
    if (capture.current || scene.objects.length >= 80) return;
    const controller = new AbortController();
    capture.current = controller;
    setNotice("");
    setCaptureState("正在导入 GLB 素材…");
    setError(null);
    try {
      const model = await importDirectorModel(file, category, controller.signal);
      controller.signal.throwIfAborted();
      setModels(previous => [...previous, model].sort((a, b) => a.name.localeCompare(b.name, "zh-CN")));
      add("model", { modelId: model.id, name: model.name });
      setNotice("GLB 已导入并保存到本地场景资产。");
    } catch (failure) {
      if (!controller.signal.aborted) setError(directorError(failure));
    } finally {
      capture.current = null;
      if (!controller.signal.aborted) setCaptureState("");
    }
  }

  function template(kind: "dialogue" | "product") {
    const first = directorObject(kind === "dialogue" ? "character" : "cylinder", 0);
    const second = directorObject("female", 1);
    const camera = { ...directorObject("camera", 0), ...viewport.current?.cameraPose() };
    onChange(current => ({ ...current, objects: kind === "dialogue" ? [first, second, camera] : [first, camera], tracks: [] }));
    select(camera.id);
    setView(null);
    setFrame(0);
  }

  function importScene(incoming: DirectorScene, how: DirectorImportMode) {
    const next = mergeDirectorLayout(scene, incoming, how);
    onChange(() => next, { clearPanorama: how === "replace" });
    select(null);
    setView(null);
    setFrame(0);
    setImportTab(null);
    setError(null);
    setNotice(`已导入 ${incoming.objects.length} 个场景对象。`);
  }

  async function exportMedia(count: 1 | 4 | 12 | "video") {
    const current = viewport.current;
    if (!current || !available || capture.current) return;
    const controller = new AbortController();
    capture.current = controller;
    setError(null);
    setNotice("");
    setCaptureState(count === "video" ? "正在导出视频…" : "正在保存截图…");
    try {
      if (count === "video") {
        const blob = await current.record(scene.aspect, scene.duration, controller.signal);
        const [w, h] = scene.aspect.split(":").map(Number) as [number, number];
        await onCapture([{ name: `${node.name} · 预演`, kind: "video", aspectRatio: w / h, blob }], controller.signal);
      } else {
        const frames = current.capture(scene.aspect, count);
        const media = await Promise.all(frames.map(async (frame, index): Promise<DirectorMediaCapture> => ({
          kind: "image", aspectRatio: frame.width / frame.height, blob: await encode(frame),
          name: `${node.name} · ${count === 1 ? activeCamera?.name ?? "当前视角" :
            count === 4 ? directorViewLabels[index * 2] : `方位 ${index + 1}`}`,
        })));
        await onCapture(media, controller.signal);
      }
      setNotice(count === "video" ? "预演视频已保存到画布。" : `已保存 ${count} 张截图到画布。`);
    } catch (failure) {
      if (!controller.signal.aborted) setError(directorError(failure));
    } finally {
      capture.current = null;
      if (!controller.signal.aborted) setCaptureState("");
    }
  }

  function submitMotion(cameraId: string) {
    if (!available || !viewport.current || !motionPrompt.trim() || locked) return;
    setError(null);
    try {
      const frame = viewport.current.capture(scene.aspect, 1)[0];
      if (!frame) throw new Error("无法截取当前视角。");
      onMotion(node.key, { cameraId, prompt: motionPrompt.trim(), preview: frame.toDataURL("image/png") });
    } catch (failure) { setError(directorError(failure)); }
  }

  function keys(event: KeyboardEvent<HTMLDialogElement>) {
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229 || event.defaultPrevented ||
      !(event.target instanceof HTMLElement) || event.target.closest("input, textarea, [role='listbox'], [contenteditable]")) return;
    if (locked) return;
    const key = event.key.toLowerCase();
    if ((event.ctrlKey || event.metaKey) && key === "z") {
      event.preventDefault(); event.stopPropagation();
      if (event.shiftKey) onRedo(); else onUndo();
    } else if (event.key === "Delete" && item) { event.preventDefault(); event.stopPropagation(); remove(); }
    else if (event.ctrlKey || event.metaKey || event.altKey) return;
    else if (key === "v" || key === "r" || key === "f") setMode(key === "v" ? "translate" : key === "r" ? "rotate" : "scale");
    else if (key === "t" || key === "h" || key === "y") { setView(null); viewport.current?.reset(key === "t" ? "top" : key === "y" ? "front" : "default"); }
    else if (key === "x") setSnap(value => !value);
    else if (key === "c" && item?.kind === "camera" && viewport.current) edit(item.id, viewport.current.cameraPose());
  }

  const displayedTransform = item ? time > 0 && playing ? transformAt(scene, item, time) : item : null;
  return createPortal(<dialog ref={dialog} className="canvas-director-editor" aria-labelledby={titleId} aria-modal="true" onKeyDown={keys}
    onCancel={event => {
      if (event.target !== dialog.current) return;
      event.preventDefault();
      if (drawing) finishDrawing(false);
      else if (help) setHelp(false);
      else onClose();
    }}>
    <header className="canvas-director-editor__header">
      <button type="button" className="canvas-director-editor__icon" aria-label="返回画布" data-tooltip="返回画布" onClick={onClose}>
        <LibTVMediaIcon name="close" size={18} />
      </button>
      <div className="canvas-director-editor__title"><LibTVMediaIcon name="menu-q4-director" size={18} />
        <h2 id={titleId}>{node.name}</h2><span>3D导演台</span></div>
      <div className="canvas-director-editor__views">
        <button type="button" disabled={locked} aria-pressed={!activeCamera} onClick={() => setView(null)}>导演视角</button>
        <button type="button" disabled={locked || !cameras.length} aria-pressed={Boolean(activeCamera)}
          onClick={() => setView(item?.kind === "camera" ? item.id : cameras[0]?.id ?? null)}>机位视角</button>
      </div>
      <button type="button" aria-expanded={help} onClick={() => setHelp(value => !value)}>快捷键</button>
    </header>
    {help ? <p className="canvas-director-editor__notice">V 移动 · R 旋转 · F 缩放 · T 俯视 · Y 正视 · H 重置 · X 吸附 · C 将导演视角应用到机位 · Ctrl+Z 撤销 · Del 删除</p> : null}
    {(error || generationError || captureState || generating || drawing || notice) ? <p className="canvas-director-editor__notice" role={error || generationError ? "alert" : "status"}>
      {error ?? generationError ?? (captureState || (drawing ? "按住鼠标左键绘制轨迹，完成后写入时间轴。" : generating ? "正在运行模型…" : notice))}
    </p> : null}
    <div className="canvas-director-editor__main">
      <aside className="canvas-director-editor__sidebar" aria-label="场景资产">
        <div className="canvas-director-editor__section-label">场景资产</div>
        <div className="canvas-director-editor__tabs" aria-label="资产分类">{ASSET_TABS.map(([key, label]) =>
          <button type="button" key={key} aria-pressed={tab === key} onClick={() => { setTab(key); setQuery(""); }}>{label}</button>)}</div>
        {tab !== "templates" ? <input type="search" aria-label="搜索资产" placeholder="搜索资产…" value={query} onChange={event => setQuery(event.target.value)} /> : null}
        {tab === "props" || tab === "people" ? <label className="canvas-director-editor__file">
          <LibTVMediaIcon name="plus-s" size={16} />上传 GLB {tab === "people" ? "角色" : "道具"}
          <input type="file" className="sr-only" accept=".glb,model/gltf-binary" aria-label={tab === "people" ? "上传 GLB 角色" : "上传 GLB 道具"}
            disabled={locked || scene.objects.length >= 80} onChange={event => {
              const file = event.currentTarget.files?.[0];
              event.currentTarget.value = "";
              if (file) void importModel(file, tab);
            }} />
        </label> : null}
        <div className="canvas-director-editor__assets">
          {tab === "templates" ? <>
            <button type="button" disabled={locked} onClick={() => template("dialogue")}><LibTVMediaIcon name="perspnal-n" size={24} />双人对话</button>
            <button type="button" disabled={locked} onClick={() => template("product")}><LibTVMediaIcon name="style-cube" size={24} />产品预演</button>
          </> : tab === "camera" ? <>
            {matches("添加机位") ? <button type="button" disabled={locked || scene.objects.length >= 80} onClick={() => add("camera")}>
              <LibTVMediaIcon name="plus-s" size={24} />添加机位
            </button> : null}
            {directorCameras.filter(([name]) => matches(name)).map(([name, position, target, fov]) =>
              <button type="button" key={name} disabled={locked || scene.objects.length >= 80}
                onClick={() => add("camera", { name, position, rotation: directorLookAt(position, target), fov })}>
                <LibTVMediaIcon name="camera-video" size={24} />{name}
              </button>)}
          </> : shown.map(([kind, label]) => <button type="button" disabled={locked || scene.objects.length >= 80} key={kind}
            onClick={() => add(kind, kind === "image_board" ? { imageKey: references[0]?.key } : undefined)}>
            <LibTVMediaIcon name={assetIcon(kind)} size={24} />{label}
          </button>)}
        </div>
        {shownModels.length ? <>
          <div className="canvas-director-editor__section-label">本地模型</div>
          <div className="canvas-director-editor__assets">{shownModels.map(model =>
            <button type="button" key={model.id} disabled={locked || scene.objects.length >= 80} data-tooltip={model.name}
              onClick={() => add("model", { modelId: model.id, name: model.name })}>
              <LibTVMediaIcon name={model.category === "people" ? "perspnal-n" : "style-cube"} size={24} /><span>{model.name}</span>
            </button>)}</div>
        </> : null}
        <div className="canvas-director-editor__section-label">场景大纲 <small>{scene.objects.length}</small></div>
        <ul className="canvas-director-editor__outline">
          {scene.objects.map(object => <li key={object.id}>
            <button type="button" disabled={locked} aria-pressed={object.id === selectedId} onClick={() => { select(object.id); setView(null); viewport.current?.setTime(null); }}>
              <LibTVMediaIcon name={assetIcon(object.kind)} size={15} /><span>{object.name}</span>
            </button>
          </li>)}
        </ul>
      </aside>
      <div className="canvas-director-editor__view">
        <div className="canvas-director-editor__webgl" ref={viewportHost} aria-label="3D 场景视口" />
        {!available ? <div className="canvas-director-editor__unavailable">3D 视口暂不可用</div> : null}
        {guide ? <div className="canvas-director-editor__guide" aria-hidden="true" /> : null}
        <div className="canvas-director-editor__tools">
          {TRANSFORMS.map(([value, label, key]) => <button type="button" key={value} aria-pressed={mode === value} disabled={locked}
            data-tooltip={`${label} · ${key}`} onClick={() => { viewport.current?.setTime(null); setMode(value); }}>{label}</button>)}
          <button type="button" disabled={locked} aria-pressed={snap} onClick={() => setSnap(value => !value)}>吸附</button>
          <button type="button" disabled={locked} aria-pressed={guide} onClick={() => setGuide(value => !value)}>参考线</button>
          <button type="button" disabled={locked} onClick={() => { setView(null); viewport.current?.reset("top"); }}>俯视</button>
          <button type="button" disabled={locked} onClick={() => { setView(null); viewport.current?.reset("front"); }}>正视</button>
          <button type="button" disabled={locked} onClick={() => { setView(null); viewport.current?.reset("default"); }}>重置视角</button>
        </div>
        <div className="canvas-director-editor__shots">
          {SHOT_COUNTS.map(([count, label]) => <button type="button" key={count} disabled={locked || !available} onClick={() => void exportMedia(count)}>
            {count === 1 ? <LibTVMediaIcon name="camera" size={16} /> : null}{label}
          </button>)}
        </div>
      </div>
      <aside className="canvas-director-editor__sidebar canvas-director-editor__properties" aria-label="属性">
        <div className="canvas-director-editor__section-label">{item ? "对象属性" : "场景设置"}</div>
        {item && displayedTransform ? <>
          <label>名称<input key={item.id} type="text" maxLength={80} value={item.name} disabled={locked}
            onChange={event => edit(item.id, { name: event.target.value || "未命名对象" })} /></label>
          {FIELDS.map(([field, label]) => <fieldset key={field} disabled={locked}><legend>{label}</legend>
            {["X", "Y", "Z"].map((axis, index) => <label key={axis}>{axis}<input type="number" step={field === "rotation" ? 1 : .1}
              aria-label={label + " " + axis} min={field === "scale" ? 0.05 : -1000} max={field === "scale" ? 100 : 1000}
              value={Number(displayedTransform[field][index]!.toFixed(2))} onChange={event => {
                const number = event.target.valueAsNumber;
                if (!Number.isFinite(number)) return;
                const vector = [...item[field]] as DirectorTransform[typeof field];
                vector[index] = Math.min(field === "scale" ? 100 : 1000, Math.max(field === "scale" ? 0.05 : -1000, number));
                edit(item.id, { [field]: vector });
              }} /></label>)}
          </fieldset>)}
          {item.kind === "camera" ? <>
            <label>视野角 <input type="range" min={15} max={100} value={item.fov} disabled={locked}
              onChange={event => edit(item.id, { fov: event.target.valueAsNumber })} /></label>
            <button type="button" disabled={locked} onClick={() => setView(item.id)}>切换到此机位视角</button>
            <button type="button" disabled={locked || !available || Boolean(activeCamera)} onClick={() => {
              if (viewport.current) edit(item.id, viewport.current.cameraPose());
            }}>应用当前视角到此机位</button>
            <details>
              <summary>AI 运镜</summary>
              <textarea aria-label="运镜提示词" placeholder="例如：缓慢推进并绕角色右侧四分之一圈" maxLength={2000}
                value={motionPrompt} disabled={locked} onChange={event => setMotionPrompt(event.target.value)} />
              <button type="button" disabled={locked || !available || !motionPrompt.trim()}
                onClick={() => submitMotion(item.id)}>生成运镜</button>
              <small>将当前视角与场景布局发送给文本模型，按供应商计费。结果会替换当前机位的轨道。</small>
            </details>
          </> : item.kind !== "model" ? <label>颜色<input type="color" value={item.color} disabled={locked}
            onChange={event => edit(item.id, { color: event.target.value })} /></label> : null}
          {isDirectorBody(item.kind) ? <section className="canvas-director-editor__pose" aria-label="角色姿势">
            <div className="canvas-director-editor__section-label">姿势预设</div>
            <div className="canvas-director-editor__presets">{directorPosePresets.map(([label, pose]) =>
              <button type="button" disabled={locked} key={label} onClick={() => editPose(pose)}>{label}</button>)}</div>
            <div className="canvas-director-editor__section-label">姿势调节</div>
            {directorJointSections.map(([section, controls]) => <details key={section}>
              <summary>{section}</summary>
              {controls.map(([joint, axis, label, min, max]) => {
                const angle = directorJointAngle(item.jointAngles, joint, axis);
                return <label key={joint + axis}><span>{label}</span>
                  <input type="range" min={min} max={max} step={1} value={angle} disabled={locked}
                    aria-label={`${section} ${label}角度`} onChange={event => editPose({
                      ...item.jointAngles, [joint]: { ...item.jointAngles?.[joint], [axis]: event.target.valueAsNumber },
                    }, true)} />
                  <output>{Math.round(angle)}°</output>
                </label>;
              })}
            </details>)}
          </section> : null}
          {item.kind === "image_board" ? <>
            <CanvasSelect ariaLabel="图片板素材" value={referenceUrls.has(item.imageKey ?? "") ? item.imageKey ?? "" : ""}
              options={[{ value: "", label: "无图片" }, ...references.map(ref => ({ value: ref.key, label: ref.name }))]}
              disabled={locked} onChange={value => edit(item.id, { imageKey: value || undefined })} />
            <button type="button" disabled={locked} onClick={() => onPick(node.key)}>添加图片板素材</button>
          </> : null}
          <div className="canvas-director-editor__row">
            <button type="button" disabled={locked || scene.objects.length >= 80} onClick={duplicate}>复制</button>
            <button type="button" disabled={locked} onClick={remove}><LibTVMediaIcon name="trash" size={14} />删除</button>
          </div>
        </> : null}
        <div className="canvas-director-editor__section-label">环境与构图</div>
        <label>背景颜色 <input type="color" value={scene.background} disabled={locked}
          onChange={event => { const background = event.target.value; onChange(current => ({ ...current, background })); }} /></label>
        <CanvasSelect ariaLabel="画面比例" value={scene.aspect} options={ASPECTS.map(value => ({ value, label: value }))}
          disabled={locked} onChange={value => onChange(current => ({ ...current, aspect: value as DirectorScene["aspect"] }))} />
        {cameras.length ? <CanvasSelect ariaLabel="当前机位" value={activeCamera?.id ?? ""}
          options={[{ value: "", label: "导演视角" }, ...cameras.map(camera => ({ value: camera.id, label: camera.name }))]}
          disabled={locked} onChange={value => setView(value || null)} /> : null}
        <CanvasSelect ariaLabel="全景图" value={panorama ? node.panoramaKey ?? "" : ""}
          options={[{ value: "", label: "无全景图" }, ...references.filter(ref => ref.previewUrl).map(ref => ({ value: ref.key, label: ref.name }))]}
          disabled={locked} onChange={value => onPanorama(value || null)} />
        <button type="button" disabled={locked} onClick={() => onPick(node.key)}><LibTVMediaIcon name="plus-s" size={16} />添加参考图</button>
        <button type="button" disabled={locked} onClick={() => setImportTab("image")}>AI 识图导入</button>
        <details><summary>AI 搭景</summary>
          <textarea aria-label="场景描述" placeholder="描述想要搭建的场景" value={node.prompt} maxLength={8000} disabled={locked}
            onChange={event => onPrompt(node.key, event.target.value)} />
          <button type="button" disabled={locked || (!node.prompt.trim() && !references.length)} onClick={() => onGenerate(node.key)}>生成3D场景</button>
          <small>按供应商计费。生成结果会替换当前布局，可用撤销恢复。</small>
        </details>
        <div className="canvas-director-editor__row">
            <button type="button" disabled={locked} onClick={() => setImportTab("json")}>导入 JSON</button>
            <button type="button" disabled={locked} onClick={() => {
              void copyTextToDesktopClipboard(JSON.stringify(scene, null, 2))
                .then(() => { setError(null); setNotice("已复制场景 JSON。"); })
                .catch(failure => setError(directorError(failure)));
            }}>复制场景 JSON</button>
        </div>
      </aside>
    </div>
    <footer className="canvas-director-editor__timeline" aria-label="时间轴">
      <div className="canvas-director-editor__row">
        <strong>时间轴</strong>
        <button type="button" disabled={!available || Boolean(captureState)} aria-label={playing ? "暂停" : "播放"} onClick={() => {
          playFrom.current = time >= scene.duration ? 0 : time;
          setPlaying(value => !value);
        }}><LibTVMediaIcon name={playing ? "icon-pause-filled-small" : "icon-play-filled-small"} size={16} /></button>
        <button type="button" disabled={Boolean(captureState)} onClick={() => { setPlaying(false); setFrame(0); }}>停止</button>
        <label><input type="checkbox" checked={loop} disabled={playing || Boolean(captureState)} onChange={event => setLoop(event.target.checked)} />循环</label>
        <label>时长 <input type="number" min={1} max={30} step={1} value={scene.duration} disabled={locked} aria-label="动画时长"
          onChange={event => {
            const duration = event.target.valueAsNumber;
            if (Number.isFinite(duration) && duration >= 1 && duration <= 30) {
              onChange(current => ({ ...current, duration }));
              if (time > duration) setFrame(duration);
            }
          }} /> 秒</label>
        <button type="button" disabled={locked || !item || selectedFrames.length >= 120} onClick={toggleKeyframe}>◆ 添加／移除关键帧</button>
        <button type="button" disabled={locked || !item} onClick={() => motionPath("line")}>直线路径</button>
        <button type="button" disabled={locked || !item} onClick={() => motionPath("ring")}>圆环路径</button>
        <button type="button" disabled={locked || !item} onClick={() => motionPath("rectangle")}>矩形路径</button>
        {drawing ? <>
          <button type="button" onClick={() => finishDrawing(true)}>完成路径</button>
          <button type="button" onClick={() => finishDrawing(false)}>取消路径</button>
        </> : <button type="button" disabled={locked || !item || !available} onClick={startDrawing}>绘制路径</button>}
        <button type="button" className="canvas-director-editor__export" disabled={locked || !available} onClick={() => void exportMedia("video")}>导出视频到画布</button>
      </div>
      <div className="canvas-director-editor__scrub">
        <span>{time.toFixed(1)}s</span><input type="range" min={0} max={scene.duration} step={0.1} value={time} disabled={locked}
          aria-label="时间轴位置" onChange={event => setFrame(event.target.valueAsNumber, true)} /><span>{scene.duration}s</span>
      </div>
      {scene.tracks.length ? <div className="canvas-director-editor__tracks">{scene.tracks.map(track => <div key={track.objectId}>
        <button type="button" disabled={locked} onClick={() => select(track.objectId)}>{scene.objects.find(object => object.id === track.objectId)?.name}</button>
        {track.keyframes.filter(frame => frame.time <= scene.duration).map(frame => <button type="button" key={frame.time} disabled={locked}
          onClick={() => { select(track.objectId); setFrame(frame.time, true); }}>◆ {Number(frame.time.toFixed(2))}s</button>)}
      </div>)}</div> : <small>选择一个角色、道具或机位后可添加关键帧。</small>}
    </footer>
    {importTab ? <CanvasDirectorImport initialTab={importTab} references={references} models={visionModels} defaultModel={defaultModel}
      busy={generating} generationError={generationError}
      onClose={() => setImportTab(null)} onPick={() => onPick(node.key)} onRecognize={request => {
        void onRecognize(node.key, request)?.then(applied => {
          if (applied) {
            setImportTab(null);
            setView(null);
            setFrame(0);
            setNotice("参考图场景已导入。");
          }
        });
      }}
      onImport={importScene} /> : null}
  </dialog>, document.body);
}
