import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import { Share2 } from "lucide-react";
import { CanvasSelect } from "../../components/CanvasSelect";
import { useEscapeHandler } from "../../components/escapeArbiter";
import {
  backendErrorMessage, generationClient, isDesktopRuntime, pickPromptMultimodalFiles, promptNodeClient,
  type PickedPromptMaterial, type PromptReferenceInput,
} from "../../lib/backend";
import { CanvasFeatureAssetPicker, type ListFeatureAssets } from "./CanvasFeatureAssetPicker";
import type { CanvasFeatureTarget } from "./canvasFeatureCatalog";
import { copyTextToDesktopClipboard } from "./desktopActions";
import { LibTVMediaIcon, type LibTVMediaIconName } from "./LibTVMediaIcon";
import { STORYBOARD_ASSET_DRAG_TYPE, type StoryboardAsset, type StoryboardLayout } from "./storyboardProject";
import { TvDirectorScriptPresetDialog, type DirectorPresetDraft } from "./TvDirectorScriptPresetDialog";
import {
  DIRECTOR_NODE_LABELS, DIRECTOR_SCRIPT_MODELS, DIRECTOR_TASKS, directorDraftKey, directorMediaTaskId, directorRequest, loadDirectorHistory,
  isDirectorMediaKind, newDirectorThread, parseDirectorReply, type DirectorCanvasContext, type DirectorHistory,
  type DirectorIntent, type DirectorJob, type DirectorScriptSettings, type DirectorTurn,
} from "./tvDirector";
import type { AssetItem, NodeModelSelection } from "./workspaceModel";
import "./CanvasTvDirector.css";

type DirectorModel = NodeModelSelection & { readonly label: string; readonly remoteModelId: string };
interface Attachment {
  readonly id: string;
  readonly name: string;
  readonly file?: PickedPromptMaterial;
  readonly reference?: PromptReferenceInput | undefined;
  readonly nodeKey?: string;
}
type Source = CanvasFeatureTarget & PromptReferenceInput;

function DirectorIconButton({ label, icon, onClick, pressed }: {
  readonly label: string;
  readonly icon: LibTVMediaIconName;
  readonly onClick: () => void;
  readonly pressed?: boolean;
}) {
  return <button type="button" className="tv-director__icon" aria-label={label} data-tooltip={label}
    aria-pressed={pressed} onClick={onClick}><LibTVMediaIcon name={icon} size={18} /></button>;
}

const modelKey = ({ providerId, modelDefinitionId }: NodeModelSelection) => JSON.stringify([providerId, modelDefinitionId]);
const matchModelId = (id: string) => id.split("/").at(-1)?.toLowerCase().replace(/[^a-z0-9]/g, "");
const presetModels = [...DIRECTOR_SCRIPT_MODELS.models].sort((left, right) =>
  Number(right.key === DIRECTOR_SCRIPT_MODELS.defaultKey) - Number(left.key === DIRECTOR_SCRIPT_MODELS.defaultKey));
const qualityOptions = [
  { value: "auto", label: "自动" },
  { value: "hd", label: "高清", icon: <LibTVMediaIcon name="hd" size={15} /> },
];

export function CanvasTvDirector({ canvasId, open, onClose, models, defaultModel, nodeKeys, getCanvasContext, getSources,
  listAssets, assetReference, importFile, hasCloud, onApply, onLocate, onRun, storyboard, referenceRequest, onReferenceHandled }: {
  readonly canvasId: string;
  readonly open: boolean;
  readonly onClose: () => void;
  readonly models: readonly DirectorModel[];
  readonly defaultModel: NodeModelSelection;
  readonly nodeKeys: ReadonlySet<string>;
  readonly getCanvasContext: (keys: readonly string[], includeCanvas: boolean) => { context: DirectorCanvasContext; sources: DirectorTurn["sources"] };
  readonly getSources: (kind: AssetItem["kind"]) => readonly Source[];
  readonly listAssets: ListFeatureAssets;
  readonly assetReference: (asset: AssetItem) => PromptReferenceInput | null;
  readonly importFile: (kind: AssetItem["kind"], path: string | null, signal: AbortSignal) => Promise<AssetItem | null>;
  readonly hasCloud: boolean;
  readonly onApply: (turn: DirectorTurn, panelLeft: number) => Record<string, string> | undefined;
  readonly onLocate: (keys: readonly string[], panelLeft: number) => void;
  readonly onRun: (turn: DirectorTurn, jobs: readonly DirectorJob[], saveJob: (job: DirectorJob) => void,
    setProgress: (progress: string) => void, signal: AbortSignal) => Promise<void>;
  readonly storyboard?: {
    readonly layout: StoryboardLayout;
    readonly onChange: (next: Partial<StoryboardLayout>) => void;
    readonly getAssets: () => readonly StoryboardAsset[];
    readonly openScript: (key: string) => void;
    readonly openFilm: (turn: DirectorTurn, draftId: string) => Promise<void>;
  } | undefined;
  readonly referenceRequest?: { readonly id: string; readonly asset: StoryboardAsset } | null;
  readonly onReferenceHandled?: (id: string) => void;
}) {
  const storageKey = "canvas-tv-director:v1:" + canvasId;
  const [history, setHistory] = useState(() => loadDirectorHistory(storageKey));
  const historyRef = useRef(history);
  const [view, setView] = useState<"chat" | "history" | "attachments">("chat");
  const [expanded, setExpanded] = useState(false);
  const [presetOpen, setPresetOpen] = useState(false);
  const [scriptDraft, setScriptDraft] = useState<{ value: DirectorPresetDraft; settings: DirectorScriptSettings } | null>(null);
  const [intent, setIntent] = useState<DirectorIntent>(() =>
    turnIntent(history.threads.find(thread => thread.id === history.active)?.turns.at(-1)));
  const [picker, setPicker] = useState<AssetItem["kind"] | null>(null);
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<readonly Attachment[]>([]);
  const [useCanvas, setUseCanvas] = useState(false);
  const [chosenModel, setChosenModel] = useState("");
  const [issue, setIssue] = useState("");
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmRun, setConfirmRun] = useState<string | null>(null);
  const [runProgress, setRunProgress] = useState("");
  const [runningTurn, setRunningTurn] = useState<string | null>(null);
  const [openingFilm, setOpeningFilm] = useState(false);
  const runControl = useRef<AbortController | null>(null);
  const [notifications, setNotifications] = useState(false);
  const [notificationDismissed, setNotificationDismissed] = useState(false);
  const [headerMenu, setHeaderMenu] = useState<"settings" | "layout" | null>(null);
  const [projectPicker, setProjectPicker] = useState(false);
  const [referenceQuery, setReferenceQuery] = useState("");
  const [dropActive, setDropActive] = useState(false);
  const handledReference = useRef<string | null>(null);
  const notificationsRef = useRef(false);
  const inFlight = useRef<string | null>(null);
  const pickingFiles = useRef(false);
  const panel = useRef<HTMLElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const threadScroll = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const current = history.threads.find(thread => thread.id === history.active)!;
  const quality = history.quality ?? "auto";
  const scriptOriginal = intent === "script_original";
  const presetModel = intent !== "omni" ? presetModels
    .map(preset => models.find(option => [preset.key, preset.label].some(id => matchModelId(option.remoteModelId) === matchModelId(id))))
    .find(Boolean) : undefined;
  const model = models.find(option => modelKey(option) === chosenModel) ??
    presetModel ?? models.find(option => modelKey(option) === modelKey(defaultModel)) ?? models[0];
  const modelOptions = useMemo(() => models.map(option => ({ value: modelKey(option), label: option.label })), [models]);
  const sourceOptions = picker && open ? getSources(picker) : [];
  const projectChoices = storyboard && projectPicker ? storyboard.getAssets().filter(asset =>
    asset.label.toLocaleLowerCase().includes(referenceQuery.trim().toLocaleLowerCase())).slice(0, 48) : [];

  function turnIntent(turn: DirectorTurn | undefined): DirectorIntent {
    return turn?.intent ?? (turn?.scriptOriginal ? "script_original" : "omni");
  }

  function save(next: DirectorHistory) {
    try {
      localStorage.setItem(storageKey, JSON.stringify(next));
    } catch {
      setIssue("无法保存导演对话。当前内容仍可查看，请检查本机存储空间。");
      historyRef.current = next;
      setHistory(next);
      return false;
    }
    historyRef.current = next;
    setHistory(next);
    return true;
  }

  function append(turn: DirectorTurn) {
    const previous = historyRef.current;
    return save({
      ...previous,
      threads: previous.threads.map(thread => thread.id === previous.active ? {
        ...thread, title: thread.turns.length ? thread.title : turn.input.slice(0, 36),
        turns: [...thread.turns, turn],
      } : thread),
    });
  }

  function updateTurn(turnId: string, update: (turn: DirectorTurn) => DirectorTurn) {
    const previous = historyRef.current;
    return save({
      ...previous,
      threads: previous.threads.map(thread => ({
        ...thread, turns: thread.turns.map(turn => turn.id === turnId ? update(turn) : turn),
      })),
    });
  }

  function finish(turnId: string, result: Pick<DirectorTurn, "status" | "plan" | "error">) {
    updateTurn(turnId, turn => ({ ...turn, ...result }));
  }

  useEffect(() => () => runControl.current?.abort(), []);

  useEffect(() => {
    if (open && !storyboard?.layout.enabled) composer.current?.focus({ preventScroll: true });
  }, [open, storyboard?.layout.enabled]);

  useEffect(() => {
    if (!open || !storyboard || !headerMenu) return;
    const dismiss = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Element && (target.closest(".canvas-select__menu") ||
          (panel.current?.contains(target) && target.closest(".tv-director__header, .tv-director__storyboard-menu")))) return;
      setHeaderMenu(null);
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [open, storyboard, headerMenu]);

  useEffect(() => {
    if (!open || !referenceRequest || handledReference.current === referenceRequest.id) return;
    handledReference.current = referenceRequest.id;
    if (nodeKeys.has(referenceRequest.asset.key)) attachProjectAsset(referenceRequest.asset);
    onReferenceHandled?.(referenceRequest.id);
  }, [open, referenceRequest, nodeKeys, onReferenceHandled]);

  useEffect(() => {
    const element = threadScroll.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [current.turns, open, view]);

  useEscapeHandler({
    canHandle: event => event.target instanceof Node && !!panel.current?.contains(event.target) &&
      (!storyboard || headerMenu != null || projectPicker || picker != null || view !== "chat"),
    handle: () => {
      if (headerMenu) setHeaderMenu(null);
      else if (projectPicker) setProjectPicker(false);
      else if (picker) setPicker(null);
      else if (view !== "chat") setView("chat");
      else if (!storyboard) close();
    },
  }, open);

  function close() {
    setConfirmRun(null);
    onClose();
  }

  function changeThread(id?: string) {
    const previous = historyRef.current;
    if (id) save({ ...previous, active: id });
    else {
      const next = newDirectorThread();
      save({ ...previous, active: next.id, threads: [next, ...previous.threads] });
    }
    setDraft("");
    setUseCanvas(false);
    setIssue("");
    setAttachments([]);
    setView("chat");
    setPicker(null);
    setConfirmRun(null);
    setScriptDraft(null);
    setIntent(turnIntent(previous.threads.find(thread => thread.id === id)?.turns.at(-1)));
    setProjectPicker(false);
    setHeaderMenu(null);
  }

  function attachReference(reference: PromptReferenceInput) {
    const id = JSON.stringify(reference.target);
    setAttachments(previous => previous.length >= 8 || previous.some(item => item.id === id) ? previous :
      [...previous, { id, name: reference.displayName, reference }]);
    setPicker(null);
    setView("chat");
  }

  function attachAsset(asset: AssetItem) {
    const reference = assetReference(asset);
    if (reference) attachReference(reference);
    else setIssue("该素材暂时无法读取，请从画布或本地素材库重新选择。");
  }

  function attachProjectAsset(asset: StoryboardAsset) {
    const id = "project:" + asset.key;
    setAttachments(previous => previous.length >= 8 || previous.some(item => item.id === id) ? previous :
      [...previous, { id, name: asset.label, reference: asset.reference, nodeKey: asset.key }]);
    setProjectPicker(false);
    setPicker(null);
    setView("chat");
    requestAnimationFrame(() => composer.current?.focus({ preventScroll: true }));
  }

  function chooseProjectReference() {
    setReferenceQuery("");
    setProjectPicker(previous => !previous);
  }

  async function attachFiles(story: boolean) {
    if (pickingFiles.current) return;
    pickingFiles.current = true;
    const owner = historyRef.current.active;
    try {
      const files = await pickPromptMultimodalFiles(story ? { title: "上传故事来改编", kinds: ["document"] } : { title: "添加导演参考素材" });
      if (!files.length || historyRef.current.active !== owner) return;
      setAttachments(previous => {
        const paths = new Set(previous.map(item => item.id));
        return [...previous, ...files.filter(file => !paths.has(file.localPath)).map(file =>
          ({ id: file.localPath, name: file.displayName, file }))].slice(0, 8);
      });
      if (story) {
        setScriptDraft(null);
        setIntent("script_adaptation");
        setDraft(DIRECTOR_TASKS.find(task => task.id === "adapt")!.draft);
      }
      setView("chat");
    } catch (error) {
      setIssue(backendErrorMessage(error));
    } finally {
      pickingFiles.current = false;
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    const input = draft.trim();
    if ((!input && !attachments.length && !scriptDraft) || inFlight.current) return;
    if (!isDesktopRuntime() || !model) {
      setIssue("请在桌面应用的设置中启用支持文本生成的模型。");
      return;
    }
    const nodeReferences = attachments.flatMap(attachment => attachment.nodeKey ? [attachment.nodeKey] : []);
    if (nodeReferences.some(key => !nodeKeys.has(key))) {
      setIssue("引用的项目素材已从画布移除，请重新选择。");
      return;
    }
    const context = useCanvas || nodeReferences.length ? getCanvasContext(nodeReferences, useCanvas) : null;
    const styleImage = scriptDraft?.value.styleImage;
    const files = attachments.flatMap(attachment => attachment.file ? [attachment.file] : []);
    if (styleImage && !files.some(file => file.localPath === styleImage.localPath)) files.unshift(styleImage);
    const turn: DirectorTurn = {
      id: crypto.randomUUID(), status: "pending", input: input || (scriptDraft ? "根据剧本设定创作。" : "请分析所附参考素材。"),
      attachments: [
        ...files.map(file => file.displayName),
        ...attachments.flatMap(attachment => attachment.reference || attachment.nodeKey ? [attachment.name] : []),
      ], sources: context?.sources ?? {}, quality, intent, scriptSettings: scriptDraft?.settings,
    };
    setIssue("");
    if (!append(turn)) {
      finish(turn.id, { status: "failed", error: "未能保存本轮对话，请检查本机存储空间。" });
      return;
    }
    inFlight.current = turn.id;
    setBusy(true);
    setDraft("");
    setAttachments([]);
    setScriptDraft(null);
    try {
      const result = await promptNodeClient.run({
        canvasId, sourceNodeId: "tv-director-" + turn.id,
        mode: "video_prompt", generalText: true, task: "generate",
        providerConnectionId: model.providerId, modelDefinitionId: model.modelDefinitionId,
        userPrompt: directorRequest(turn.input, context?.context ?? null, intent, scriptDraft?.settings),
        contextHistory: current.turns.filter(item => item.plan).slice(-8).flatMap(item => [
          { role: "user" as const, content: item.input.slice(0, 1600) },
          { role: "assistant" as const, content: (item.plan?.reply ?? "").slice(0, 4000) },
        ]),
        multimodalInputs: files,
        referenceInputs: attachments.flatMap(attachment => attachment.reference ? [attachment.reference] : []),
      });
      finish(turn.id, { status: "complete", plan: parseDirectorReply(result.optimizedPrompt, turn.sources) });
      if (notificationsRef.current && document.hidden && typeof Notification !== "undefined" && Notification.permission === "granted") {
        try { new Notification("TV Director", { body: "导演回复已就绪。" }); } catch { /* WebView may restrict notifications. */ }
      }
    } catch (error) {
      finish(turn.id, { status: "failed", error: backendErrorMessage(error) });
    } finally {
      inFlight.current = null;
      setBusy(false);
    }
  }

  async function recover(turn: DirectorTurn) {
    if (checking || turn.id === inFlight.current) return;
    setChecking(true);
    setIssue("");
    try {
      const { items } = await generationClient.list({ canvasId, sourceNodeId: "tv-director-" + turn.id, limit: 1 });
      const task = items[0];
      if (!task) {
        setIssue("暂未找到本轮请求记录。可以稍后再次查询。");
      } else if (task.status === "succeeded") {
        const detail = await generationClient.get(task.id);
        finish(turn.id, { status: "complete", plan: parseDirectorReply(detail.textOutput?.optimizedPrompt ?? "", turn.sources) });
      } else if (["failed", "interrupted", "unknown", "cancelled"].includes(task.status)) {
        const detail = await generationClient.get(task.id);
        finish(turn.id, {
          status: "failed",
          error: detail.finalError ? backendErrorMessage(detail.finalError) : "请求已结束，未收到完整回复。",
        });
      } else {
        setIssue("供应商还在处理这一轮，请稍后查询。");
      }
    } catch (error) {
      setIssue(backendErrorMessage(error));
    } finally {
      setChecking(false);
    }
  }

  async function runPlan(turn: DirectorTurn) {
    if (runControl.current || !turn.plan) return;
    setIssue("");
    setConfirmRun(null);
    const controller = new AbortController();
    runControl.current = controller;
    setRunningTurn(turn.id);
    setRunProgress("检查生成方案…");
    try {
      const jobs = turn.jobs ?? await Promise.all(turn.plan.nodes.filter(node => isDirectorMediaKind(node.kind))
        .map(async (node): Promise<DirectorJob> => ({
          draftId: node.id, taskId: await directorMediaTaskId(turn.id, node.id), status: "ready",
        })));
      controller.signal.throwIfAborted();
      if (!updateTurn(turn.id, currentTurn => ({ ...currentTurn, jobs }))) return;
      await onRun(turn, jobs, job => {
        if (!updateTurn(turn.id, currentTurn => ({
          ...currentTurn, jobs: currentTurn.jobs?.map(candidate => candidate.draftId === job.draftId ? job : candidate) ?? [],
        }))) throw new Error("未能保存任务记录，已暂停方案。");
      }, setRunProgress, controller.signal);
    } catch (error) {
      if (!controller.signal.aborted) setIssue(backendErrorMessage(error));
    } finally {
      runControl.current = null;
      setRunningTurn(null);
      setRunProgress("");
    }
  }

  async function toggleNotifications() {
    if (notifications) {
      notificationsRef.current = false;
      setNotifications(false);
      return;
    }
    try {
      if (typeof Notification === "undefined" || await Notification.requestPermission() !== "granted") {
        setIssue("当前窗口未获得浏览器通知权限。");
        return;
      }
      notificationsRef.current = true;
      setNotifications(true);
    } catch (error) {
      setIssue(backendErrorMessage(error));
    }
  }

  function openDirectorTask(id: typeof DIRECTOR_TASKS[number]["id"] | "directing") {
    setIssue("");
    if (id === "presets") {
      setPresetOpen(true);
      return;
    }
    setScriptDraft(null);
    if (id === "adapt") {
      setIntent("script_adaptation");
      setUseCanvas(false);
      void attachFiles(true);
      return;
    }
    const directing = id === "directing" || id === "optimize";
    setIntent(directing ? "directing" : "omni");
    setUseCanvas(directing || id === "canvas");
    const text = DIRECTOR_TASKS.find(task => task.id === id)?.draft;
    if (text) setDraft(text);
    composer.current?.focus();
  }

  async function shareThread() {
    try {
      const turns = current.turns.map(turn => `## 用户\n${turn.input}\n\n## TV Director\n${turn.plan?.reply ?? turn.error ?? ""}`);
      await copyTextToDesktopClipboard([`# ${current.title}`, ...turns].join("\n\n"));
      setIssue("对话已复制到剪贴板。");
    } catch (error) {
      setIssue(backendErrorMessage(error));
    }
  }

  function toggleHistory() {
    setPicker(null);
    setHeaderMenu(null);
    setView(view === "history" ? "chat" : "history");
  }

  if (!open) return null;
  const modelControls = <>
    <CanvasSelect ariaLabel="导演输出画质" className="tv-director__quality" value={quality} preferAbove
      title="高清按已选媒体模型支持的画质写入新节点"
      options={qualityOptions} onChange={value => {
        if (value === "auto" || value === "hd") save({ ...historyRef.current, quality: value });
      }} />
    <CanvasSelect ariaLabel="导演文本模型" value={model ? modelKey(model) : ""} preferAbove
      options={modelOptions.length ? modelOptions : [{ value: "", label: "未配置文本模型" }]}
      disabled={!model} onChange={setChosenModel} className="tv-director__model" />
  </>;
  const intentLabel = scriptOriginal ? "剧本原创" : intent === "script_adaptation" ? "剧本改编" : "导演执导";
  return (
    <>
    <aside ref={panel} className={"tv-director" + (storyboard ? " tv-director--storyboard" : expanded ? " tv-director--expanded" : "")}
      aria-labelledby={titleId} onDragOver={event => {
        if (!storyboard || !event.dataTransfer.types.includes(STORYBOARD_ASSET_DRAG_TYPE)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
        setDropActive(true);
      }} onDragLeave={event => {
        if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setDropActive(false);
      }} onDrop={event => {
        if (!storyboard || !event.dataTransfer.types.includes(STORYBOARD_ASSET_DRAG_TYPE)) return;
        event.preventDefault();
        setDropActive(false);
        const key = event.dataTransfer.getData(STORYBOARD_ASSET_DRAG_TYPE);
        const asset = storyboard.getAssets().find(candidate => candidate.key === key);
        if (asset) attachProjectAsset(asset);
      }}>
      <header className="tv-director__header">
        <h2 id={titleId}>{storyboard ? <button type="button" className="tv-director__thread-title"
          aria-label={current.title + " · 对话历史"} aria-expanded={view === "history"} onClick={toggleHistory}>
          <span>{view === "attachments" ? "添加素材" : current.title}</span><LibTVMediaIcon name="icon-chevron-down-small" size={12} />
        </button> : view === "history" ? "对话历史" : view === "attachments" ? "添加素材" : current.title}</h2>
        <DirectorIconButton label="新对话" icon="plus-s" onClick={() => changeThread()} />
        {storyboard ? <>
          <button type="button" className="tv-director__icon" aria-label="复制对话" data-tooltip="复制对话"
            disabled={!current.turns.length} onClick={() => void shareThread()}><Share2 size={16} aria-hidden="true" /></button>
          <DirectorIconButton label="导演设置" icon="icon-generate-settings1" pressed={headerMenu === "settings"}
            onClick={() => setHeaderMenu(headerMenu === "settings" ? null : "settings")} />
          <DirectorIconButton label="布局" icon="storyboard" pressed={headerMenu === "layout"}
            onClick={() => setHeaderMenu(headerMenu === "layout" ? null : "layout")} />
        </> : <>
          <DirectorIconButton label="对话历史" icon="library-q4-history" pressed={view === "history"} onClick={toggleHistory} />
          <DirectorIconButton label={expanded ? "缩小导演面板" : "展开导演面板"} icon="expand" pressed={expanded}
            onClick={() => setExpanded(!expanded)} />
          <DirectorIconButton label="关闭 TV Director" icon="close" onClick={close} />
        </>}
      </header>
      {storyboard && headerMenu ? <div className="tv-director__storyboard-menu"
        aria-label={headerMenu === "settings" ? "导演设置" : "布局"}>
        {headerMenu === "layout" ? <>
          <strong>对话位置</strong>
          {(["left", "right"] as const).map(side => <button key={side} type="button"
            aria-pressed={storyboard.layout.chatSide === side} onClick={() => storyboard.onChange({ chatSide: side })}>
            <LibTVMediaIcon name="storyboard" size={16} />{side === "left" ? "左侧" : "右侧"}
          </button>)}
          <button type="button" role="switch" aria-checked={storyboard.layout.showAssets}
            onClick={() => storyboard.onChange({ showAssets: !storyboard.layout.showAssets })}>显示项目素材</button>
        </> : <>
          <strong>模型与画质</strong>
          {modelControls}
          <button type="button" role="switch" aria-checked={notifications}
            onClick={() => void toggleNotifications()}>开启浏览器通知</button>
        </>}
      </div> : null}

      {picker ? <CanvasFeatureAssetPicker kind={picker} targets={sourceOptions} titleId={titleId + "-assets"} listAssets={listAssets}
        hasCloud={hasCloud} onBack={() => setPicker(null)}
        onChoose={key => {
          const source = getSources(picker).find(item => item.key === key);
          if (source) attachReference(source);
        }}
        onChooseAsset={attachAsset}
        onChooseFile={async (path, signal) => {
          const asset = await importFile(picker, path, signal);
          if (asset && !signal.aborted) attachAsset(asset);
        }} /> : (
        <div className="tv-director__body" ref={threadScroll}>
          {view === "history" ? (
            <div className="tv-director__choices">
              {history.threads.map(thread => <button key={thread.id} type="button" aria-current={thread.id === history.active}
                onClick={() => changeThread(thread.id)}><LibTVMediaIcon name="library-q4-history" />{thread.title}</button>)}
            </div>
          ) : view === "attachments" ? (
            <div className="tv-director__choices">
              <button type="button" onClick={() => setView("chat")}>返回对话</button>
              <button type="button" onClick={() => void attachFiles(false)}><LibTVMediaIcon name="upload" />上传文件</button>
              {(["image", "video", "audio"] as const).map(kind => <button key={kind} type="button" onClick={() => setPicker(kind)}>
                <LibTVMediaIcon name="library-q4-grid" />从画布或素材库选{DIRECTOR_NODE_LABELS[kind]}
              </button>)}
            </div>
          ) : !current.turns.length ? (
            <div className="tv-director__welcome">
              <span className="canvas-bottom-dock__brand-mark" aria-hidden="true" />
              <h3>让 TV Director 辅助你的无限创意</h3>
              <div className="tv-director__choices">
                {DIRECTOR_TASKS.map(task => <button key={task.id} type="button" onClick={() => openDirectorTask(task.id)}>
                  <LibTVMediaIcon name={task.icon} /><span>{task.label}</span>
                  {storyboard ? <LibTVMediaIcon name="icon-chevron-right-small" size={15} /> : null}
                </button>)}
              </div>
            </div>
          ) : current.turns.map(turn => {
            const plan = turn.plan;
            const placed = plan?.nodes.map(node => directorDraftKey(turn.id, node.id)).filter(key => nodeKeys.has(key)) ?? [];
            const totalMedia = plan?.nodes.filter(node => isDirectorMediaKind(node.kind)).length ?? 0;
            const savedMedia = turn.jobs?.filter(job => job.status === "complete").length ?? 0;
            return <section key={turn.id} className="tv-director__turn">
              <div className="tv-director__bubble">{turn.input}
                {turn.scriptSettings ? <small>剧本设定 · {turn.scriptSettings.genre} · {turn.scriptSettings.episodes == null ? "自动" : `${turn.scriptSettings.episodes} 集`}</small> : null}
                {turn.attachments.length ? <small>{turn.attachments.join(" · ")}</small> : null}
              </div>
              <div className="tv-director__reply">
                <strong>TV Director</strong>
                {turn.status === "pending" ? <p role="status">{inFlight.current === turn.id ? "正在创作…" :
                  <button type="button" disabled={checking} onClick={() => void recover(turn)}>查询已提交的回复</button>}</p> : null}
                {turn.status === "failed" ? <>
                  <p role="status">{turn.error ?? "没有收到回复。"}</p>
                  <button type="button" disabled={checking} onClick={() => void recover(turn)}>查询任务记录</button>
                </> : null}
                {plan ? <p>{plan.reply}</p> : null}
                {plan?.nodes.length ? <div className="tv-director__plan">
                  <strong>画布方案 · {plan.nodes.length} 个节点 · {plan.links.length} 条连线</strong>
                  {plan.nodes.map(node => {
                    const key = directorDraftKey(turn.id, node.id);
                    const job = turn.jobs?.find(item => item.draftId === node.id);
                    const status = job?.status === "complete" ? "已保存" : job?.status === "recorded" ? "待核对任务" : "待生成";
                    return <div className="tv-director__plan-row" key={node.id}>
                      <details>
                        <summary>{DIRECTOR_NODE_LABELS[node.kind]} · {node.name}</summary>
                        {placed.length && turn.appliedQuality?.[node.id] ? <small>{turn.appliedQuality[node.id]}</small> : null}
                        <p>{node.prompt}</p>
                      </details>
                      {placed.includes(key) && storyboard ? <div className="tv-director__plan-actions">
                        {isDirectorMediaKind(node.kind) ? <small>{status}</small> : null}
                        {node.kind === "screenplay" ? <button type="button" onClick={() => {
                          setIssue("");
                          try { storyboard.openScript(key); } catch (error) { setIssue(backendErrorMessage(error)); }
                        }}><LibTVMediaIcon name="icon-storyboard-gen" size={15} />制作分镜</button> : null}
                        {node.kind === "video_clip" ? <button type="button" disabled={openingFilm}
                          onClick={() => {
                            setIssue("");
                            setOpeningFilm(true);
                            void Promise.resolve().then(() => storyboard.openFilm(turn, node.id))
                              .catch(error => setIssue(backendErrorMessage(error))).finally(() => setOpeningFilm(false));
                          }}><LibTVMediaIcon name="icon-storyboard-gen" size={15} />{openingFilm ? "正在读取片段…" : "剪辑成片"}</button> : null}
                      </div> : null}
                    </div>;
                  })}
                  {placed.length ? <button type="button" onClick={() =>
                    onLocate(placed, panel.current?.getBoundingClientRect().left ?? window.innerWidth)}>定位画布节点</button> :
                    <button type="button" onClick={() => {
                      setIssue("");
                      try {
                        const appliedQuality = onApply({ ...turn, quality }, panel.current?.getBoundingClientRect().left ?? window.innerWidth);
                        updateTurn(turn.id, currentTurn => ({ ...currentTurn, quality, appliedQuality }));
                      }
                      catch (error) { setIssue(backendErrorMessage(error)); }
                    }}>放到画布</button>}
                  {placed.length === plan.nodes.length && totalMedia ? (
                    runningTurn === turn.id ? <>
                      <p role="status">已保存 {savedMedia}/{totalMedia} · {runProgress}</p>
                      <button type="button" onClick={() => runControl.current?.abort()}>暂停后续提交</button>
                    </> : turn.jobs?.length && turn.jobs.every(job => job.status === "complete") ?
                      <p>已保存 {savedMedia}/{totalMedia} 个媒体节点的产物。</p> : confirmRun === turn.id ? <>
                        <p>将核对 {totalMedia} 个媒体节点并使用各节点当前模型，按依赖顺序继续。新的生成任务可能扣费。</p>
                        <button type="button" onClick={() => void runPlan(turn)}>确认生成</button>
                        <button type="button" onClick={() => setConfirmRun(null)}>取消</button>
                      </> :
                        <button type="button" disabled={runningTurn !== null} onClick={() => setConfirmRun(turn.id)}>
                          {turn.jobs?.some(job => job.status !== "ready") ? "查询任务并继续" : "按方案生成媒体"}
                        </button>
                  ) : null}
                </div> : null}
              </div>
            </section>;
          })}
        </div>
      )}
      {issue ? <p role="status" className="tv-director__issue">{issue}</p> : null}
      {storyboard && view === "chat" && !picker ? <div className="tv-director__storyboard-options">
        {!notifications && !notificationDismissed && !current.turns.length ? <div className="tv-director__notification-banner">
          <span>开启浏览器通知，及时获取最新消息</span>
          <button type="button" onClick={() => void toggleNotifications()}>开启</button>
          <DirectorIconButton label="关闭通知提示" icon="close" onClick={() => setNotificationDismissed(true)} />
        </div> : null}
        <div className="tv-director__storyboard-modes" role="group" aria-label="导演创作模式">
          <button type="button" aria-pressed={scriptOriginal} onClick={() => openDirectorTask("presets")}>
            <LibTVMediaIcon name="icon-script-ai" />剧本原创
          </button>
          <button type="button" aria-pressed={intent === "script_adaptation"} onClick={() => openDirectorTask("adapt")}>
            <LibTVMediaIcon name="prompt-optimize" />剧本改编
          </button>
          <button type="button" aria-pressed={intent === "directing"} onClick={() => openDirectorTask("directing")}>
            <LibTVMediaIcon name="icon-storyboard-gen" />导演执导
          </button>
          {intent !== "omni" ? <DirectorIconButton label={"退出" + intentLabel} icon="close" onClick={() => {
            setIntent("omni"); setScriptDraft(null); setUseCanvas(false);
          }} /> : null}
        </div>
      </div> : null}
      {view === "chat" && !picker ? <form className="tv-director__composer" onSubmit={event => void submit(event)}>
        {scriptDraft ? <div className="tv-director__preset-chip">
          <button type="button" data-tooltip="编辑剧本设定" onClick={() => setPresetOpen(true)}>
            <LibTVMediaIcon name="icon-script-ai" size={15} />{scriptDraft.settings.genre} · {scriptDraft.settings.episodes == null ? "自动" : `${scriptDraft.settings.episodes} 集`}
          </button>
          <DirectorIconButton label="移除剧本设定" icon="close" onClick={() => setScriptDraft(null)} />
        </div> : null}
        {attachments.length ? <div className="tv-director__attachments">{attachments.map(item => (
          <button key={item.id} type="button" aria-label={"移除附件 " + item.name}
            onClick={() => setAttachments(previous => previous.filter(candidate => candidate.id !== item.id))}>
            <span>{item.name}</span><LibTVMediaIcon name="close" size={12} />
          </button>
        ))}</div> : null}
        {projectPicker && storyboard ? <div className="tv-director__project-picker" aria-label="引用项目素材">
          <div><input aria-label="搜索项目素材" placeholder="搜索项目素材" value={referenceQuery} autoFocus
            onChange={event => setReferenceQuery(event.target.value)}
            onKeyDown={event => { if (event.key === "Enter") event.preventDefault(); }} />
          <DirectorIconButton label="关闭项目素材选择" icon="close" onClick={() => setProjectPicker(false)} /></div>
          {projectChoices.length ? projectChoices.map(asset => <button type="button" key={asset.key}
            onClick={() => attachProjectAsset(asset)}>{asset.label}</button>) : <small>暂无匹配的项目素材</small>}
        </div> : null}
        <textarea ref={composer} aria-label="给 TV Director 的消息"
          placeholder={storyboard ? "开始你的创作，或者 @ 引用节点或资源" : "告诉 TV Director 你想创作什么"}
          value={draft} maxLength={12000} onChange={event => setDraft(event.target.value)}
          onKeyDown={event => {
            if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
            if (event.key === "@" && storyboard) {
              event.preventDefault();
              chooseProjectReference();
            } else if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }} />
        <div className="tv-director__composer-tools">
          {storyboard ? <>
            <DirectorIconButton label="上传文件" icon="plus-s" onClick={() => void attachFiles(false)} />
            <DirectorIconButton label="从素材库添加" icon="style-cube" onClick={() => setView("attachments")} />
            <DirectorIconButton label="引用项目素材" icon="icon-canvas-add" pressed={projectPicker} onClick={chooseProjectReference} />
            <DirectorIconButton label="感知画布" icon="hand-n" pressed={useCanvas} onClick={() => setUseCanvas(!useCanvas)} />
          </> : <>
          <DirectorIconButton label="添加素材" icon="plus-s" onClick={() => setView("attachments")} />
          {intent !== "omni" ? <div className="tv-director__script-mode">
            <button type="button" className="tv-director__mode" onClick={() => {
              if (scriptOriginal) setPresetOpen(true);
              else setUseCanvas(!useCanvas);
            }}>{intentLabel}</button>
            <button type="button" aria-label={"退出" + intentLabel} data-tooltip={"退出" + intentLabel} onClick={() => {
              setIntent("omni");
              setScriptDraft(null);
            }}><LibTVMediaIcon name="close" size={12} /></button>
          </div> :
            <button type="button" className="tv-director__mode" aria-pressed={useCanvas}
              data-tooltip={useCanvas ? "已引用画布的节点摘要和提示词" : "全能创作 · 点击引用画布"}
              onClick={() => setUseCanvas(!useCanvas)}>{useCanvas ? "引用画布" : "全能创作"}</button>}
          {modelControls}
          </>}
          <button type="submit" className="tv-director__send" aria-label="发送给 TV Director"
            data-tooltip="发送 · 使用所选模型的供应商额度" disabled={busy || (!draft.trim() && !attachments.length && !scriptDraft)}>
            <LibTVMediaIcon name="up-arrow" size={18} />
          </button>
        </div>
        {!storyboard ? <button className="tv-director__notification" type="button" role="switch" aria-checked={notifications}
          onClick={() => void toggleNotifications()}>开启浏览器通知</button> : null}
      </form> : null}
      {dropActive && storyboard ? <div className="tv-director__drop-hint">拖到这里，作为对话素材</div> : null}
    </aside>
    {presetOpen ? <TvDirectorScriptPresetDialog initial={scriptDraft?.value ?? null}
      onClose={() => setPresetOpen(false)} onConfirm={(value, settings, prefill) => {
        setScriptDraft({ value, settings });
        setIntent("script_original");
        if (prefill) setDraft(prefill);
        else setDraft(previous => previous.trim() ? previous : `我想创作一部「${settings.genre}」题材的短剧剧本：`);
        setUseCanvas(false);
        setPresetOpen(false);
        requestAnimationFrame(() => composer.current?.focus({ preventScroll: true }));
      }} /> : null}
    </>
  );
}
