/*
 * 创作台：第二入口（`?view=create`）· 即梦式整页外壳。
 *
 * 侧栏 + 顶栏 + 记录流 + 底部浮坞 + 资产库抽屉，五件套构成一页。
 *
 * 与画布工作台的关系：同一个前端产物，两个入口。
 *   - studio 画布工作台（默认）：节点、连线、素材库。
 *   - create 这一页：桌面端像即梦创作页，资产库接本项目自己的素材库。
 *
 * 数据全部走本项目自有 API：模型来自已接入的供应商目录，参数来自模型自己声明
 * 的能力表，生成走 generationClient，资产库走本机 Base64 与云端素材库。
 * 不复用被逆向方的任何端点或签名。
 */
import { Suspense, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { ErrorAlert } from "../../components/ErrorAlert";
import type { GenerationOperation, MediaLibraryKind } from "../../lib/backend";
import { modelParameterCapabilities, type ModelParameterValue } from "../../lib/modelCapabilities";
import { toast } from "../../lib/toast";
import { DeferredDialogFallback, ProviderSettingsDialog } from "../workspace/deferredDialogs";
import {
  CREATE_COPY,
  createModeById,
  mergeParameterValues,
  modeOperations,
  type CreateModeId,
} from "./createModel";
import {
  AGENT_COPY,
  AGENT_PROMPT_MAX_LENGTH,
  composeAgentPrompt,
  creationModeFromLocation,
  composerVariantFor,
  isPromptOverLimit,
  standardModeFor,
  AGENT_PENDING_NOTICE,
  type AgentCreationModeId,
} from "./createAgentModel";
import { loadCreationPreferences, saveCreationPreferences } from "./createPreferences";
import {
  useCreateSession,
  type CreateModelOption,
  type CreateRecord,
  type CreateReference,
  type CreateResultItem,
} from "./useCreateSession";
import { useCreateAgent } from "./useCreateAgent";
import type { AssetItem } from "../workspace/workspaceModel";
import { CreateAgentComposer } from "./CreateAgentComposer";
import { CreateAssetDrawer } from "./CreateAssetDrawer";
import { CreateComposer } from "./CreateComposer";
import { CreateRecordList } from "./CreateRecordList";
import { CreateSidebar } from "./CreateSidebar";
import { CreateTopBar } from "./CreateTopBar";
import { referenceFromAsset, type CreateRecordFilter } from "./createPageModel";
import { useCreateAssets } from "./useCreateAssets";
import "./CreateSurface.css";
import "./CreateAgentSurface.css";

/**
 * 创作类型 → 生成操作。
 *
 * 带参考素材时优先走图生图 / 参考生视频：有参考图却按文生图提交，
 * 模型不会把它当条件，等于白传。
 */
function resolveOperation(
  model: CreateModelOption | null,
  mode: CreateModeId,
  hasImageReference: boolean,
): GenerationOperation {
  if (!model) return createModeById(mode).operation;
  const descriptor = createModeById(mode);
  if (mode === "image" && hasImageReference && model.operations.includes("image_to_image")) {
    return "image_to_image";
  }
  if (model.operations.includes(descriptor.operation)) return descriptor.operation;
  return model.operations[0] ?? descriptor.operation;
}

export function CreateSurface() {
  const session = useCreateSession();
  const assets = useCreateAssets();
  const agent = useCreateAgent();

  /*
   * 两套创作类型，互不干扰。
   *
   * - `standardMode` 是标准浮坞的模式（图片/视频/文本/音频），与服务端偏好
   *   一起持久化——这是本项目原有的行为，不动。
   * - `creationMode` 是 Agent 浮坞里那份 7 项清单的当前项（含 Agent 模式本身）。
   *
   * 即梦这两份清单在两个浮坞里是分开的：Agent 浮坞的下拉有 7 项，
   * 标准浮坞的下拉只有 4 项 + 一个「Agent 模式」入口。所以本项目也是
   * 两份状态，不强行合成一份。
   */
  const [standardMode, setStandardMode] = useState<CreateModeId>("video");
  const [creationMode, setCreationMode] = useState<AgentCreationModeId>(() =>
    creationModeFromLocation(typeof window === "undefined" ? null : window.location),
  );
  /** 当前渲染的是 Agent 浮坞还是标准浮坞。 */
  const variant = composerVariantFor(creationMode);

  const [preferredModelId, setPreferredModelId] = useState<string | null>(null);
  const [chosen, setChosen] = useState<Record<string, ModelParameterValue>>({});
  const [prompt, setPrompt] = useState("");
  const [references, setReferences] = useState<readonly CreateReference[]>([]);

  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [assetsOpen, setAssetsOpen] = useState(false);
  /** 抽屉当前是「浏览素材库」还是「挑参考素材」。 */
  const [picking, setPicking] = useState(false);
  /** 抽屉里已选的素材 ID。 */
  const [pickedIds, setPickedIds] = useState<readonly string[]>([]);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<CreateRecordFilter>("all");
  const [settingsOpen, setSettingsOpen] = useState(false);
  /**
   * 提交失败的报错 id：交给提交键做 `aria-describedby`（WCAG 3.3.1），
   * 键盘用户走到提交键就知道刚才为什么失败。
   */
  const submitErrorId = useId();

  /*
   * 主页面配置：进来先读上次用的创作类型与模型。
   *
   * 读到的模型可能已经不在目录里（供应商解绑、模型停用），那时退回列表首个，
   * 不报错——配置只是「上次用的」，不是「必须存在」。
   */
  const savedPreferenceRef = useRef<{
    readonly mode: CreateModeId | null;
    readonly modelDefinitionId: string | null;
  } | null>(null);
  useEffect(() => {
    let cancelled = false;
    void loadCreationPreferences().then((prefs) => {
      if (cancelled) return;
      savedPreferenceRef.current = prefs;
      // 读回来的只是「上次用的生成模式」；Agent 模式是浮坞形态，不在这里覆盖。
      if (prefs.mode) setStandardMode(prefs.mode);
      if (prefs.modelDefinitionId) setPreferredModelId(prefs.modelDefinitionId);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * 创作类型或模型变化时把选择写回服务端偏好。
   *
   * 只在与「刚读到的／上次写过的」不同时才写：否则打开页面就会用默认值
   * 覆盖用户上一次的选择。
   */
  useEffect(() => {
    const previous = savedPreferenceRef.current;
    if (previous === null) return;
    if (previous.mode === standardMode && previous.modelDefinitionId === preferredModelId) return;
    savedPreferenceRef.current = { mode: standardMode, modelDefinitionId: preferredModelId };
    void saveCreationPreferences({ mode: standardMode, modelDefinitionId: preferredModelId });
  }, [standardMode, preferredModelId]);

  /**
   * 切换浮坞形态。
   *
   * URL 上的 `?type=` **只承载 agentic**：即梦用 `?type=agentic` 切 Agent 浮坞，
   * 其余四种生成类型走的是服务端偏好那条线。把七项都写进 URL 会和
   * 服务端偏好打架（刷新后到底听谁的），所以这里只在进出 Agent 模式时
   * 写/删这个参数。
   */
  const onVariantChange = useCallback((next: AgentCreationModeId) => {
    setCreationMode(next);
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    if (next === "agentic") url.searchParams.set("type", "agentic");
    else url.searchParams.delete("type");
    window.history.replaceState(null, "", url);
  }, []);

  /**
   * Agent 浮坞的「创作类型」下拉。
   *
   * 选「Agent 模式」留在 Agent 浮坞；选其它类型就切回标准浮坞，并把标准
   * 浮坞的模式一并带过去（音乐/数字人/动作模仿落到最接近的后端能力）。
   */
  const onAgentModeChange = useCallback(
    (next: AgentCreationModeId) => {
      if (next === "agentic") {
        onVariantChange("agentic");
        return;
      }
      setStandardMode(standardModeFor(next));
      onVariantChange(next);
    },
    [onVariantChange],
  );

  /** 当前创作类型下可选的模型：必须声明支持该类型下的某个操作，否则提交会被拒。 */
  const models = useMemo(() => {
    const operations = modeOperations(standardMode);
    return session.models.filter((model) =>
      model.operations.some((operation) => operations.includes(operation)),
    );
  }, [standardMode, session.models]);

  const model = useMemo(
    () => models.find((item) => item.modelDefinitionId === preferredModelId) ?? models[0] ?? null,
    [models, preferredModelId],
  );

  const hasImageReference = references.some((reference) => reference.mediaType === "image");

  const operation = useMemo(
    () => resolveOperation(model, standardMode, hasImageReference),
    [standardMode, model, hasImageReference],
  );

  const capabilities = useMemo(
    () =>
      model
        ? modelParameterCapabilities(model.operationSchema, operation, model.remoteModelId)
        : [],
    [model, operation],
  );

  const values = useMemo(() => mergeParameterValues(capabilities, chosen), [capabilities, chosen]);

  /* ── Agent 模式 ───────────────────────────────────────────────────── */

  /*
   * Agent 模式的模型列表与参数。
   *
   * 即梦的 Agent 模式有自己的模型选择（生成偏好面板里的「其他设置」），
   * 产物类型由偏好里的「图片 / 视频」决定，而不是由创作类型决定。
   * 因此这里按偏好里的产物类型取对应操作的模型列表。
   */
  const agentModels = useMemo(() => {
    const operations: readonly GenerationOperation[] =
      agent.preferences.outputType === "video"
        ? ["video_generation"]
        : ["text_to_image", "image_to_image"];
    return session.models.filter((item) =>
      item.operations.some((operation) => operations.includes(operation)),
    );
  }, [agent.preferences.outputType, session.models]);

  const agentModel = useMemo(
    () =>
      agentModels.find((item) => item.modelDefinitionId === agent.preferences.modelDefinitionId) ??
      agentModels[0] ??
      null,
    [agentModels, agent.preferences.modelDefinitionId],
  );

  const agentOperation = useMemo(() => {
    if (agent.preferences.outputType === "video") return "video_generation" as const;
    if (agentModel?.operations.includes("image_to_image") && hasImageReference) {
      return "image_to_image" as const;
    }
    return "text_to_image" as const;
  }, [agent.preferences.outputType, agentModel, hasImageReference]);

  const agentCapabilities = useMemo(
    () =>
      agentModel
        ? modelParameterCapabilities(
            agentModel.operationSchema,
            agentOperation,
            agentModel.remoteModelId,
          )
        : [],
    [agentModel, agentOperation],
  );

  /**
   * Agent 模式的参数值。
   *
   * 比例来自「生成偏好」面板，因此要覆盖能力表里的默认比例；
   * 「智能」时不覆盖——交给后端决定（与普通创作页一致）。
   */
  const agentValues = useMemo(() => {
    const merged = mergeParameterValues(agentCapabilities, chosen);
    if (agent.preferences.aspectRatio === "auto") return merged;
    const ratioCapability = agentCapabilities.find(
      (capability) => capability.key === "ratio" || capability.key === "aspect_ratio",
    );
    if (!ratioCapability) return merged;
    const option = ratioCapability.options.find(
      (item) => String(item.value) === agent.preferences.aspectRatio,
    );
    if (!option) return merged;
    return { ...merged, [ratioCapability.key]: option.value };
  }, [agent.preferences.aspectRatio, agentCapabilities, chosen]);

  /** Agent 模式的提交。 */
  const agentSubmit = useCallback(async () => {
    if (!agentModel) return;
    /*
     * 先把真实情况讲清楚：Agent 编排运行时后端暂未接入（`TODO(agent-runtime)`），
     * 本次是按所选模型直接提交生成。不能让用户以为编排跑过了。
     */
    toast(AGENT_PENDING_NOTICE);
    await session.submit({
      operation: agentOperation,
      model: agentModel,
      prompt: composeAgentPrompt({
        prompt,
        skill: agent.skill,
        subjects: agent.selectedSubjects,
      }),
      references,
      parameters: agentValues,
    });
  }, [
    agent.skill,
    agent.selectedSubjects,
    agentModel,
    agentOperation,
    agentValues,
    prompt,
    references,
    session,
  ]);

  /**
   * 参考素材是否超限。
   *
   * 限额按媒体类型分别算（实测的 reference_resource_config），
   * 超限时先说清楚「超了多少、该换什么」，而不是只说「超限」。
   */
  const referenceLimitHint = useMemo(() => {
    const counts = { image: 0, video: 0, audio: 0, total: references.length };
    for (const reference of references) {
      if (reference.mediaType === "image") counts.image += 1;
      else if (reference.mediaType === "video") counts.video += 1;
      else counts.audio += 1;
    }
    return agent.checkReferenceLimits(counts);
  }, [agent, references]);

  /**
   * Agent 模式能不能提交。
   *
   * 实测即梦的 Agent 模式允许空提示词（校验项 `allowEmpty`），只要选了技能
   * 或主体就算有效输入；提示词超长则不行（上限 20000）。
   */
  const agentCanSubmit = useMemo(() => {
    if (session.submitting || session.modelsLoading) return false;
    if (agentModel === null) return false;
    if (isPromptOverLimit(prompt)) return false;
    if (referenceLimitHint !== null) return false;
    const hasContent =
      prompt.trim() !== "" || agent.skill !== null || agent.selectedSubjects.length > 0;
    return hasContent;
  }, [
    agent.selectedSubjects.length,
    agent.skill,
    agentModel,
    prompt,
    referenceLimitHint,
    session.modelsLoading,
    session.submitting,
  ]);

  const agentDisabledHint = useMemo(() => {
    if (session.modelsLoading) return null;
    if (agentModel === null) return CREATE_COPY.noModelHint;
    if (referenceLimitHint !== null) return referenceLimitHint;
    if (isPromptOverLimit(prompt)) {
      return `提示词超过 ${AGENT_PROMPT_MAX_LENGTH} 字，请删减后再提交。`;
    }
    if (prompt.trim() === "" && agent.skill === null && agent.selectedSubjects.length === 0) {
      /*
       * 同上：即梦没有这行提示，占位文案已经说明了要做什么。
       * 空提示词 + 选了技能/主体仍可提交（`allowEmpty`），也不需要提示。
       */
      return null;
    }
    return null;
  }, [
    agent.selectedSubjects.length,
    agent.skill,
    agentModel,
    prompt,
    referenceLimitHint,
    session.modelsLoading,
  ]);

  const onParameterChange = useCallback((key: string, value: ModelParameterValue) => {
    setChosen((previous) => ({ ...previous, [key]: value }));
  }, []);

  const submit = useCallback(async () => {
    if (!model) return;
    await session.submit({
      operation,
      model,
      /*
       * 主体引用要进提示词文本（即梦提交时把主体渲染成 `subject.content.name`，
       * 见 `composeAgentPromptContents` 的注释）。普通浮坞没有技能，
       * 所以技能位传 null。
       */
      prompt: composeAgentPrompt({
        prompt,
        skill: null,
        subjects: agent.selectedSubjects,
      }),
      references,
      parameters: values,
    });
  }, [agent.selectedSubjects, model, operation, prompt, references, session, values]);

  const onRegenerate = useCallback(
    (record: CreateRecord) => {
      const target = model ?? session.models[0];
      if (!target) return;
      setPrompt(record.prompt);
      /*
       * 用**原任务的**参考素材重跑。
       *
       * 之前硬编码 `references: []` → 用户点「再次生成」后参考图/参考视频全消失，
       * 产出的是纯文生结果（参数还取的是当前浮坞值），而**照样扣费**：
       * 用户以为「重跑一遍」，实际换了输入。
       *
       * `record.references` 来自任务详情的 logicalRequest 快照（提交那一刻的
       * 参考素材），所以重跑的是「同一次输入」。
       */
      void session.submit({
        operation,
        model: target,
        prompt: record.prompt,
        references: record.references,
        parameters: values,
      });
    },
    [model, operation, session, values],
  );

  const onEdit = useCallback((record: CreateRecord) => {
    setPrompt(record.prompt);
  }, []);

  /**
   * 把一个已生成产物作为参考素材送进浮坞（即梦视频卡底部的「用作参考视频」）。
   *
   * 只有**本机已落盘**的产物能进参考素材：后端只认三种素材身份（本机文件 /
   * 云端素材 / 本机 Base64 素材），远端签名 URL 不是其中之一，直接塞 URL 会
   * 被后端按图片通道读视频、或直接忽略。
   */
  const handleUseAsReference = useCallback((result: CreateResultItem) => {
    const path = result.finalPath;
    if (!path) {
      toast.error("这个产物还没落到本机", {
        description: "等它下载完成后再作为参考素材添加。",
      });
      return;
    }
    const mediaType: MediaLibraryKind =
      result.mediaType === "video" ? "video" : result.mediaType === "audio" ? "audio" : "image";
    setReferences((previous) => [
      ...previous,
      {
        kind: "local_file",
        name: path.split(/[\\/]/).pop() ?? path,
        mediaType,
        path,
        previewUrl: result.remoteUrl,
      },
    ]);
    toast.success("已作为参考素材", { description: "在浮坞的参考条里可以看到它。" });
  }, []);

  /**
   * 「使用提示词」：把记录里的提示词填进浮坞输入框。
   *
   * 即梦在长提示词的展开层右下角放了这枚按钮，点了就把提示词送进输入框。
   */
  const handleUsePrompt = useCallback((prompt: string) => {
    setPrompt(prompt);
    toast.success("已填入提示词", { description: "在浮坞里改一改就能直接生成。" });
  }, []);

  /**
   * 用一张图直接发起视频生成（即梦图片格工具菜单里的「生成视频」）。
   *
   * 创作台本来就支持「带参考素材的参考生视频」，所以这一步只是：
   * 把图加进参考素材 + 切到视频生成档，剩下的交给浮坞。
   */
  const handleGenerateVideo = useCallback((result: CreateResultItem) => {
    const path = result.finalPath;
    if (!path) {
      toast.error("这个产物还没落到本机", {
        description: "等它下载完成后再用来生成视频。",
      });
      return;
    }
    setStandardMode("video");
    setReferences((previous) => [
      ...previous,
      {
        kind: "local_file",
        name: path.split(/[\\/]/).pop() ?? path,
        mediaType: "image",
        path,
        previewUrl: result.remoteUrl,
      },
    ]);
    toast.success("已切到视频生成", {
      description: "这张图已经作为参考素材加进浮坞，补一句描述就能生成。",
    });
  }, []);

  /** 打开抽屉挑参考素材。 */
  const openAssetLibrary = useCallback(() => {
    setPicking(true);
    setPickedIds([]);
    setAssetsOpen(true);
  }, []);

  /** 只浏览素材库。 */
  const toggleAssetLibrary = useCallback(() => {
    setPicking(false);
    setPickedIds([]);
    setAssetsOpen((open) => !open);
  }, []);

  const onPick = useCallback((asset: AssetItem) => {
    setPickedIds((previous) =>
      previous.includes(asset.id)
        ? previous.filter((id) => id !== asset.id)
        : [...previous, asset.id],
    );
  }, []);

  /** 把抽屉里选中的素材转成参考素材。 */
  const confirmPick = useCallback(() => {
    const byId = new Map(assets.assets.map((asset) => [asset.id, asset]));
    const additions: CreateReference[] = [];
    for (const id of pickedIds) {
      const asset = byId.get(id);
      if (!asset) continue;
      if (references.some((reference) => reference.assetId === asset.id)) continue;
      additions.push(referenceFromAsset(asset));
    }
    if (additions.length > 0) setReferences([...references, ...additions]);
    setPickedIds([]);
    setPicking(false);
    setAssetsOpen(false);
  }, [assets.assets, pickedIds, references]);

  const onNewConversation = useCallback(() => {
    setPrompt("");
    setReferences([]);
    setPickedIds([]);
  }, []);

  const onOpenWorkspace = useCallback(() => {
    if (typeof window === "undefined") return;
    window.location.href = window.location.pathname;
  }, []);

  const canSubmit =
    !session.submitting &&
    session.modelsLoading === false &&
    model !== null &&
    prompt.trim() !== "";

  const disabledHint = useMemo(() => {
    if (session.modelsLoading) return null;
    if (session.models.length === 0) return CREATE_COPY.noModelHint;
    if (model === null) return CREATE_COPY.noModelHint;
    /*
     * 提示词为空时**不给提示**。
     *
     * 即梦的浮坞没有这行字：提交按钮只是变灰，要做什么由占位文案说
     * （「输入想法、剧本或上传参考，支持 / 使用技能，@ 添加主体…」）。
     * 我们原来在这里挂一句「先输入提示词或添加参考素材。」，既和占位文案
     * 重复，又把工具条从中间撑开——即梦那行右侧是空的，提交按钮贴右缘。
     * 真需要用户动手的情况（没接供应商、提示词超限）仍然给提示。
     */
    return null;
  }, [model, session.models.length, session.modelsLoading]);

  const providerName = model?.providerName ?? session.models[0]?.providerName ?? null;

  return (
    <div className="create-surface" data-drawer={assetsOpen ? "open" : "closed"}>
      <CreateSidebar
        collapsed={sidebarCollapsed}
        onToggleCollapsed={() => setSidebarCollapsed((collapsed) => !collapsed)}
        conversationName="默认创作"
        onNewConversation={onNewConversation}
        onOpenWorkspace={onOpenWorkspace}
        onOpenAssets={toggleAssetLibrary}
      />

      {/*
        顶栏挂在**整页**上，不在内容列里。
        即梦实测：顶栏的容器是 `top-actions-host`（`position: absolute`），
        挂在整页（1707 宽）上——资产库抽屉开合时主区会变窄，但顶栏**不动**。
        放在内容列里的话，抽屉一开顶栏就跟着左移 94px，视觉上「顶栏被挤走了」。
      */}
      <CreateTopBar
        search={search}
        onSearchChange={setSearch}
        filter={filter}
        onFilterChange={setFilter}
        onOpenAssets={toggleAssetLibrary}
        assetsOpen={assetsOpen}
        providerName={providerName}
      />

      <main className="create-main">
        {/*
          模型目录加载失败时，浮坞仍然在：用户可以先把提示词写好，等模型恢复
          回来直接生成。输入区整个换成错误会让用户白写一遍。
        */}
        {session.modelsError ? (
          <div className="create-banner">
            <ErrorAlert error={session.modelsError} hint="检查供应商连接与模型绑定后重试。" />
          </div>
        ) : null}

        <div className="create-content">
          <CreateRecordList
            records={session.records}
            now={session.now}
            filter={filter}
            search={search}
            onRegenerate={onRegenerate}
            onEdit={onEdit}
            onUseAsReference={handleUseAsReference}
            onGenerateVideo={handleGenerateVideo}
            onUsePrompt={handleUsePrompt}
            /* 在途任务可中止：之前创作台没有取消入口，用户只能干等。 */
            onCancel={(record) => void session.cancel(record.taskId)}
          />
        </div>

        {/*
          提交失败：**必须看得见**。

          早前 `submit` 的异常只写进 `useCreateSession` 的 state，谁都没渲染：
          点「生成」→ 供应商拒绝参数 / 鉴权失败 / IPC 超时 → 抛错 → 按钮复原 →
          页面毫无变化 → 用户以为没点上 → 再点一次 → 第二次请求（可能重复扣费）。

          放在浮坞正上方（提交键就在它下面），并且与 `modelsError` **不互斥**：
          模型目录加载失败与提交失败完全可能同时存在。
        */}
        {session.submitError ? (
          <div className="create-banner create-banner--submit">
            <ErrorAlert
              id={submitErrorId}
              error={session.submitError}
              hint="检查供应商连接与模型绑定后重试；若已扣费，请先核对任务列表再重新生成。"
            />
          </div>
        ) : null}

        {/* 取消失败也要看得见：否则用户以为已经取消了，其实任务还在跑。 */}
        {session.cancelError ? (
          <div className="create-banner create-banner--submit">
            <ErrorAlert
              error={session.cancelError}
              hint="取消没有生效，任务可能仍在执行。可稍后重试取消，或到供应商后台处理。"
            />
          </div>
        ) : null}

        {/*
          两套浮坞：Agent 模式（`?type=agentic`）与普通创作页。
          即梦用同一个 `?type=` 参数切换，本项目沿用同一套语义——
          入口仍然只有 studio / create 两个。
        */}
        {variant === "agentic" ? (
          <CreateAgentComposer
            prompt={prompt}
            onPromptChange={setPrompt}
            references={references}
            onReferencesChange={setReferences}
            onOpenAssetLibrary={openAssetLibrary}
            mode={creationMode}
            onModeChange={onAgentModeChange}
            skill={agent.skill}
            onSkillChange={agent.onSkillChange}
            skills={agent.skills}
            onOpenSkillLibrary={() => {
              toast(AGENT_COPY.skillLibraryLabel);
            }}
            subjects={agent.subjects}
            selectedSubjects={agent.selectedSubjects}
            onSubjectsChange={agent.onSubjectsChange}
            onCreateSubject={() => {
              toast("主体体系后端暂未接入。");
            }}
            preferences={agent.preferences}
            onPreferencesChange={agent.onPreferencesChange}
            models={agentModels}
            onModelChange={(picked) =>
              agent.onPreferencesChange({
                ...agent.preferences,
                modelDefinitionId: picked.modelDefinitionId,
              })
            }
            canSubmit={agentCanSubmit}
            submitting={session.submitting}
            disabledHint={agentDisabledHint}
            submitErrorId={submitErrorId}
            onSubmit={() => void agentSubmit()}
          />
        ) : (
          <CreateComposer
            prompt={prompt}
            onPromptChange={setPrompt}
            references={references}
            onReferencesChange={setReferences}
            onOpenAssetLibrary={openAssetLibrary}
            mode={standardMode}
            onModeChange={setStandardMode}
            onSelectAgentMode={() => onVariantChange("agentic")}
            model={model}
            models={models}
            onModelChange={(picked) => setPreferredModelId(picked.modelDefinitionId)}
            capabilities={capabilities}
            values={values}
            onParameterChange={onParameterChange}
            canSubmit={canSubmit}
            submitting={session.submitting}
            disabledHint={disabledHint}
            submitErrorId={submitErrorId}
            onSubmit={() => void submit()}
            /*
             * 图片档占位文案里那枚「主体」芯片（即梦普通创作页实测），
             * 弹出的就是 Agent 浮坞里那块 240 宽的主体选择器——同一套浮层。
             */
            subjects={agent.subjects}
            selectedSubjects={agent.selectedSubjects}
            onSubjectsChange={agent.onSubjectsChange}
            onCreateSubject={() => {
              toast("主体体系后端暂未接入。");
            }}
          />
        )}
      </main>

      <CreateAssetDrawer
        open={assetsOpen}
        onClose={() => {
          setAssetsOpen(false);
          setPicking(false);
        }}
        assets={assets.assets}
        loading={assets.loading}
        error={assets.error}
        total={assets.total}
        source={assets.source}
        onSourceChange={assets.setSource}
        category={assets.category}
        onCategoryChange={assets.setCategory}
        query={assets.query}
        onQueryChange={assets.setQuery}
        groups={assets.groups}
        groupId={assets.groupId}
        onGroupIdChange={assets.setGroupId}
        cloudAvailable={assets.cloudAvailable}
        picking={picking}
        pickedIds={pickedIds}
        onPick={onPick}
        onConfirmPick={confirmPick}
        onUseAsReference={(asset) => {
          /*
           * 即梦资产卡菜单里的「用作参考视频/图」：点了就直接成为参考素材，
           * 不必再回到挑选流程点一次「添加为参考」。
           */
          if (references.some((reference) => reference.assetId === asset.id)) {
            toast("这个素材已经在参考素材里了。");
            return;
          }
          setReferences([...references, referenceFromAsset(asset)]);
          toast.success("已作为参考素材", { description: "在浮坞的参考条里可以看到它。" });
        }}
      />

      {/* 供应商与模型配置：模型列表为空时用户无处可去，入口必须就在页面上。 */}
      {settingsOpen ? (
        <Suspense
          fallback={
            <DeferredDialogFallback
              id="generate-settings-dialog"
              label="供应商与模型设置"
              onClose={() => setSettingsOpen(false)}
            />
          }
        >
          <ProviderSettingsDialog
            open
            onClose={() => setSettingsOpen(false)}
            onCatalogChanged={() => void session.reloadModels()}
          />
        </Suspense>
      ) : null}
      <button
        type="button"
        className="create-settings"
        aria-label="供应商与模型设置"
        aria-haspopup="dialog"
        aria-expanded={settingsOpen}
        onClick={() => setSettingsOpen((open) => !open)}
      >
        设置
      </button>
    </div>
  );
}
