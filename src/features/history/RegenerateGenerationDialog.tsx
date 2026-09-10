import { ImageSquare } from "@phosphor-icons/react/ImageSquare";
import { toMediaProxyUrl } from "../../lib/mediaProxy";
import { Play } from "@phosphor-icons/react/Play";
import { Plus } from "@phosphor-icons/react/Plus";
import { VideoCamera } from "@phosphor-icons/react/VideoCamera";
import { Waveform } from "@phosphor-icons/react/Waveform";
import { X } from "@phosphor-icons/react/X";
import {
  useEffect,
  useMemo,
  useCallback,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";

import { ImeInput } from "../../components/ImeTextField";
import {
  assetLibraryClient,
  formatRawBackendError,
  isDesktopRuntime,
  toMediaSrc,
  tosStagingClient,
  type CloudAsset,
  type ExplicitMediaInput,
  type ExplicitMediaTarget,
  type GenerationTaskClient,
  type GenerationTaskDetail,
  type LocalAssetRecord,
  type MediaReferenceTarget,
  type MediaType,
  type ModelOperationSchema,
  type PromptSegment,
  type StartGenerationCommand,
} from "../../lib/backend";
import { modelAllowsMediaOnlyPrompt } from "../../lib/modelCapabilities";
import { VideoMiddleFrame } from "../workspace/VideoMiddleFrame";
import { isVideoSourceUrl } from "../workspace/mediaPreview";
import {
  createPromptContentModule,
  type PromptContentConnection,
  type PromptContentDocumentV1,
  type PromptContentEditorSession,
  type PromptContentIssue,
  type PromptContentItem,
} from "../../lib/promptContent";
import {
  referenceCandidateFromTarget,
  type PromptReferenceCandidate,
} from "../../lib/promptReferences";
import { PromptMentionInput } from "../workspace/PromptNodeViews";
import { frozenStartCommand, isRecord } from "./regenerateGeneration";
import "./RegenerateGenerationDialog.css";

/** 对话框内提示词编辑器使用的固定节点键；模块实例只在本对话框内使用。 */
const PROMPT_EDITOR_KEY = "regenerate-generation-dialog";

function newMaterialId(): string {
  return `material-${globalThis.crypto.randomUUID()}`;
}

/** 从任务的逻辑请求中提取提示词段（与 HistoryDialog 中的展示逻辑一致）。 */
function promptSegmentsFromDetail(detail: GenerationTaskDetail): readonly PromptSegment[] {
  const request = detail.logicalRequest as { prompt?: unknown } | null;
  if (request == null || !Array.isArray(request.prompt)) return [];
  return request.prompt as readonly PromptSegment[];
}

/** 编辑中的素材：来源身份 + 显示名 + 显式媒体角色（如首帧/文档/网页）。 */
interface EditableMaterial {
  readonly id: string;
  readonly target: ExplicitMediaTarget;
  readonly role: string;
  readonly displayName: string;
}

/** 素材按「来源身份」比较：显式输入与提示词 @引用可能携带不同的画布实例键，不算不同素材。 */
function sameMaterialTarget(first: ExplicitMediaTarget, second: ExplicitMediaTarget): boolean {
  if (first.kind === "url" || second.kind === "url") {
    return (
      first.kind === "url" &&
      second.kind === "url" &&
      first.url === second.url &&
      first.mediaType === second.mediaType
    );
  }
  if (first.kind === "asset" && second.kind === "asset")
    return (
      first.mediaType === second.mediaType &&
      first.providerConnectionId === second.providerConnectionId &&
      first.assetId === second.assetId
    );
  if (first.kind === "local_asset" && second.kind === "local_asset")
    return first.mediaType === second.mediaType && first.stagingJobId === second.stagingJobId;
  if (first.kind === "local_result" && second.kind === "local_result")
    return (
      first.mediaType === second.mediaType &&
      first.generationTaskId === second.generationTaskId &&
      first.resultIndex === second.resultIndex
    );
  return (
    first.kind === "local_file" &&
    second.kind === "local_file" &&
    first.mediaType === second.mediaType &&
    first.path === second.path
  );
}

/** 来源身份签名（忽略画布实例键），用于把提示词引用映射回素材行。 */
function targetSignature(target: ExplicitMediaTarget): string {
  if (target.kind === "url") return `url:${target.mediaType}:${target.url}`;
  switch (target.kind) {
    case "asset":
      return `asset:${target.mediaType}:${target.providerConnectionId}:${target.assetId}`;
    case "local_asset":
      return `local_asset:${target.mediaType}:${target.stagingJobId}`;
    case "local_result":
      return `local_result:${target.mediaType}:${target.generationTaskId}:${target.resultIndex}`;
    case "local_file":
      return `local_file:${target.mediaType}:${target.path}`;
  }
}

function materialsFromDetail(detail: GenerationTaskDetail): EditableMaterial[] {
  const request = detail.logicalRequest;
  const explicit =
    isRecord(request) && Array.isArray(request["explicitMedia"])
      ? (request["explicitMedia"] as readonly ExplicitMediaInput[])
      : [];
  const materials: EditableMaterial[] = [];
  const push = (target: ExplicitMediaTarget, role: string, displayName: string) => {
    if (materials.some((material) => sameMaterialTarget(material.target, target))) return;
    materials.push({ id: newMaterialId(), target: structuredClone(target), role, displayName });
  };
  for (const input of explicit) {
    push(input.target, input.role ?? "", input.displayNameSnapshot);
  }
  // 只在提示词中引用、未进入显式媒体输入的引用也作为素材保留，避免重新生成时丢失。
  for (const segment of promptSegmentsFromDetail(detail)) {
    if (segment.kind !== "media_reference") continue;
    push(segment.target, "", segment.displayNameSnapshot);
  }
  return materials;
}

/** 素材行保持原始来源身份；编辑器相关视图（引用目标/连接）统一携带对话框合成实例键。 */
function editorTargetForMaterial(material: EditableMaterial): ExplicitMediaTarget {
  return {
    ...material.target,
    canvasNodeKey: `history-material-${material.id}`,
  };
}

/** 把原始提示词段还原为编辑器的初始文档：引用 chip 的实例键改写为对话框素材键。 */
function initialDocumentFromSegments(
  segments: readonly PromptSegment[],
  materials: readonly EditableMaterial[],
): PromptContentDocumentV1 {
  const byTarget = new Map<string, EditableMaterial>();
  for (const material of materials) {
    if (material.target.kind === "url") continue;
    byTarget.set(targetSignature(material.target), material);
  }
  const items: PromptContentItem[] = [];
  for (const segment of segments) {
    if (segment.kind === "text") {
      items.push({ kind: "text", text: segment.text });
      continue;
    }
    const material = byTarget.get(targetSignature(segment.target));
    if (material == null) continue;
    const canvasNodeKey = `history-material-${material.id}`;
    items.push({
      kind: "media_reference",
      mentionId: segment.mentionId,
      canvasNodeKey,
      target: { ...segment.target, canvasNodeKey },
      displayNameSnapshot: segment.displayNameSnapshot,
    });
  }
  return { schema: "prompt-content", version: 1, items };
}

const MEDIA_TYPE_LABELS: Record<MediaType, string> = {
  image: "图片",
  video: "视频",
  audio: "音频",
};

function materialKindLabel(material: EditableMaterial): string {
  return MEDIA_TYPE_LABELS[material.target.mediaType] ?? material.target.mediaType;
}

const ROLE_LABELS: Record<string, string> = {
  首帧: "首帧",
  参考图: "参考图",
  文档: "文档",
  网页: "网页",
};

function materialRoleLabel(role: string): string {
  if (!role) return "";
  return ROLE_LABELS[role] ?? role;
}

function targetSourceLabel(target: ExplicitMediaTarget): string {
  switch (target.kind) {
    case "asset":
      return "云端素材";
    case "local_asset":
      return "本地素材";
    case "local_result":
      return "生成结果";
    case "local_file":
      return "本地文件";
    case "url":
      return "链接素材";
  }
}

/** 素材行缩略图：按素材类型展示预览图；缺失或加载失败时回退为类型图标。 */
function MaterialThumb({
  previewUrl,
  mediaType,
  renewIdentity,
}: {
  previewUrl: string | null;
  mediaType: MediaType;
  /** 云端素材身份：预览签名过期时向后端续签一次（本地素材不传）。 */
  renewIdentity?: { readonly providerConnectionId: string; readonly assetId: string } | null;
}) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const [refreshedUrl, setRefreshedUrl] = useState<string | null>(null);
  const refreshAttemptedRef = useRef(false);
  const effectiveUrl = refreshedUrl ?? previewUrl;
  const failed = effectiveUrl != null && failedUrl === effectiveUrl;
  const handleImageError = () => {
    setFailedUrl(effectiveUrl);
    if (
      effectiveUrl == null ||
      refreshAttemptedRef.current ||
      renewIdentity == null ||
      renewIdentity.providerConnectionId === ""
    ) {
      return;
    }
    refreshAttemptedRef.current = true;
    void assetLibraryClient
      .refreshAssetMedia({
        providerConnectionId: renewIdentity.providerConnectionId,
        id: renewIdentity.assetId,
        mediaType,
      })
      .then((freshUrl) => {
        if (freshUrl != null && freshUrl !== "" && freshUrl !== effectiveUrl) {
          setRefreshedUrl(freshUrl);
          setFailedUrl(null);
        }
      })
      .catch(() => undefined);
  };
  // 参考视频素材取中间帧作封面；预览地址指向封面图时按图片加载。
  const videoSource = mediaType === "video" && isVideoSourceUrl(effectiveUrl) ? effectiveUrl : null;
  if (effectiveUrl == null || failed) {
    return (
      <span className="regenerate-material__thumb" aria-hidden="true">
        {mediaType === "video" ? (
          <VideoCamera size={16} weight="bold" />
        ) : mediaType === "audio" ? (
          <Waveform size={16} weight="bold" />
        ) : (
          <ImageSquare size={16} weight="bold" />
        )}
      </span>
    );
  }
  return (
    <span className="regenerate-material__thumb">
      {videoSource != null ? (
        <VideoMiddleFrame src={videoSource} objectFit="cover" onLoadError={handleImageError} />
      ) : (
        <img
          src={toMediaProxyUrl(effectiveUrl) ?? effectiveUrl}
          alt=""
          loading="lazy"
          onError={handleImageError}
        />
      )}
      {mediaType === "video" ? (
        <span className="regenerate-material__thumb-badge" aria-hidden="true">
          <Play size={10} weight="fill" />
        </span>
      ) : null}
    </span>
  );
}

/** 添加列表行缩略图：图片/视频展示预览图，缺失时回退为类型图标。 */
function AddListThumb({
  previewUrl,
  kind,
  renewIdentity,
}: {
  previewUrl: string | null;
  kind: MediaType;
  renewIdentity?: { readonly providerConnectionId: string; readonly assetId: string } | null;
}) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const [refreshedUrl, setRefreshedUrl] = useState<string | null>(null);
  const refreshAttemptedRef = useRef(false);
  const effectiveUrl = refreshedUrl ?? previewUrl;
  const failed = effectiveUrl != null && failedUrl === effectiveUrl;
  const handleImageError = () => {
    setFailedUrl(effectiveUrl);
    if (
      effectiveUrl == null ||
      refreshAttemptedRef.current ||
      renewIdentity == null ||
      renewIdentity.providerConnectionId === ""
    ) {
      return;
    }
    refreshAttemptedRef.current = true;
    void assetLibraryClient
      .refreshAssetMedia({
        providerConnectionId: renewIdentity.providerConnectionId,
        id: renewIdentity.assetId,
        mediaType: kind,
      })
      .then((freshUrl) => {
        if (freshUrl != null && freshUrl !== "" && freshUrl !== effectiveUrl) {
          setRefreshedUrl(freshUrl);
          setFailedUrl(null);
        }
      })
      .catch(() => undefined);
  };
  // 参考视频素材取中间帧作封面；预览地址指向封面图时按图片加载。
  const videoSource = kind === "video" && isVideoSourceUrl(effectiveUrl) ? effectiveUrl : null;
  if (effectiveUrl == null || failed) {
    return (
      <span className="regenerate-add__thumb" aria-hidden="true">
        {kind === "video" ? (
          <VideoCamera size={14} weight="bold" />
        ) : (
          <ImageSquare size={14} weight="bold" />
        )}
      </span>
    );
  }
  return (
    <span className="regenerate-add__thumb">
      {videoSource != null ? (
        <VideoMiddleFrame src={videoSource} objectFit="cover" onLoadError={handleImageError} />
      ) : (
        <img
          src={toMediaProxyUrl(effectiveUrl) ?? effectiveUrl}
          alt=""
          loading="lazy"
          onError={handleImageError}
        />
      )}
    </span>
  );
}

function describePreparationIssue(issue: PromptContentIssue): string {
  switch (issue.kind) {
    case "empty_prompt":
      return "提示词不能为空，且至少需要保留一条素材。";
    case "pending_reference":
      return `提示词中存在无法确定的素材引用「${issue.displayText}」，请通过 @ 选择具体素材后再重新生成。`;
    case "disconnected_reference":
    case "reference_identity_changed":
      return `提示词中引用了已移除的素材「${issue.displayName}」，请删除对应引用后再重新生成。`;
  }
}

const ADD_TABS = [
  { id: "cloud", label: "云端素材库" },
  { id: "local", label: "本地素材库" },
  { id: "url", label: "链接" },
] as const;

type AddTab = (typeof ADD_TABS)[number]["id"];

interface RegenerateGenerationDialogProps {
  readonly task: GenerationTaskDetail;
  readonly client: GenerationTaskClient;
  readonly busy: boolean;
  readonly error: string | null;
  readonly onSubmit: (command: StartGenerationCommand) => Promise<void>;
  readonly onCancel: () => void;
}

/**
 * 修改原任务的提示词与素材后重新生成。素材 = 显式媒体输入 + 提示词 @引用，
 * 两者都来自冻结请求；提示词使用与画布一致的 @ 高亮编辑器，素材行带缩略图；
 * 支持移除、从云端/本地素材库或链接补充，提交时按素材顺序重建
 * typePosition/contentIndex 并创建一次全新生成任务。
 */
export function RegenerateGenerationDialog({
  task,
  client,
  busy,
  error,
  onSubmit,
  onCancel,
}: RegenerateGenerationDialogProps) {
  const frozen = useMemo(() => frozenStartCommand(task), [task]);
  const segments = useMemo(() => promptSegmentsFromDetail(task), [task]);
  const initialMaterials = useMemo(() => materialsFromDetail(task), [task]);

  // 编辑器模块实例：挂载前预置初始文档，PromptMentionInput adopt 时自动恢复成引用 chip。
  const [promptModule] = useState(() => {
    const module = createPromptContentModule();
    module.restoreAll({
      [PROMPT_EDITOR_KEY]: initialDocumentFromSegments(segments, initialMaterials),
    });
    return module;
  });

  const [materials, setMaterials] = useState<readonly EditableMaterial[]>(initialMaterials);
  const [addTab, setAddTab] = useState<AddTab>("cloud");
  const [cloudAssets, setCloudAssets] = useState<readonly CloudAsset[] | null>(null);
  const [cloudError, setCloudError] = useState<string | null>(null);
  const [localAssets, setLocalAssets] = useState<readonly LocalAssetRecord[] | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [localResultPreviews, setLocalResultPreviews] = useState<ReadonlyMap<string, string>>(
    new Map(),
  );
  const [urlName, setUrlName] = useState("");
  const [urlValue, setUrlValue] = useState("");
  const [urlKind, setUrlKind] = useState<MediaType>("image");
  const [urlRole, setUrlRole] = useState("");
  const [urlError, setUrlError] = useState<string | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);

  // 素材来源仅在桌面运行环境可用；运行环境是静态能力，渲染时直接判定。
  const runtime = useMemo(() => isDesktopRuntime(), []);

  // 云端/本地素材库在打开时即加载（素材行缩略图需要；添加面板复用同一份数据）。
  useEffect(() => {
    if (!runtime) return;
    void assetLibraryClient
      .list({
        providerConnectionId: frozen?.providerConnectionId ?? "",
        pageNumber: 1,
        pageSize: 100,
      })
      .then(setCloudAssets)
      .catch((reason: unknown) => setCloudError(formatRawBackendError(reason)));
    void tosStagingClient
      .listLocalAssets()
      .then((page) => setLocalAssets(page.items))
      .catch((reason: unknown) => setLocalError(formatRawBackendError(reason)));
  }, [runtime, frozen?.providerConnectionId]);

  // 「生成结果」素材：从引用任务的产物里取 finalPath 作为缩略图（桌面端转换文件协议）。
  useEffect(() => {
    if (!runtime) return;
    const taskIds: string[] = [];
    for (const material of materials) {
      if (material.target.kind === "local_result") taskIds.push(material.target.generationTaskId);
    }
    const uniqueTaskIds = Array.from(new Set(taskIds));
    if (uniqueTaskIds.length === 0) return;
    let cancelled = false;
    void Promise.all(
      uniqueTaskIds.map(async (taskId) => {
        try {
          return await client.get(taskId);
        } catch {
          return null;
        }
      }),
    ).then((details) => {
      if (cancelled) return;
      const next = new Map<string, string>();
      for (const detail of details) {
        if (detail == null) continue;
        for (const result of detail.results) {
          if (result.saveStatus === "succeeded" && result.finalPath != null) {
            next.set(`${detail.summary.id}#${result.resultIndex}`, toMediaSrc(result.finalPath));
          }
        }
      }
      setLocalResultPreviews(next);
    });
    return () => {
      cancelled = true;
    };
  }, [client, materials, runtime]);

  // 逐类素材解析缩略图：云端 previewUrl/coverUrl、本地库 previewUrl、
  // 生成结果 finalPath、本地文件路径、链接图片直用 URL。
  const previewUrls = useMemo(() => {
    const next = new Map<string, string>();
    const cloudById = new Map((cloudAssets ?? []).map((asset) => [asset.id, asset] as const));
    const localById = new Map((localAssets ?? []).map((asset) => [asset.id, asset] as const));
    for (const material of materials) {
      const target = material.target;
      let preview: string | null = null;
      switch (target.kind) {
        case "asset": {
          const asset = cloudById.get(target.assetId);
          preview = asset?.previewUrl ?? asset?.coverUrl ?? null;
          break;
        }
        case "local_asset": {
          preview = localById.get(target.stagingJobId)?.previewUrl ?? null;
          break;
        }
        case "local_result": {
          preview =
            localResultPreviews.get(`${target.generationTaskId}#${target.resultIndex}`) ?? null;
          break;
        }
        case "local_file": {
          preview = runtime ? toMediaSrc(target.path) : null;
          break;
        }
        case "url": {
          preview = target.mediaType === "image" ? target.url : null;
          break;
        }
      }
      if (preview != null) next.set(material.id, preview);
    }
    return next;
  }, [materials, cloudAssets, localAssets, localResultPreviews, runtime]);

  const candidates = useMemo<readonly PromptReferenceCandidate[]>(
    () =>
      materials.flatMap((material) => {
        if (material.target.kind === "url") return [];
        const target: MediaReferenceTarget = {
          ...material.target,
          canvasNodeKey: `history-material-${material.id}`,
        };
        return [
          referenceCandidateFromTarget({
            canvasNodeKey: `history-material-${material.id}`,
            target,
            name: material.displayName,
            previewUrl: previewUrls.get(material.id) ?? null,
          }),
        ];
      }),
    [materials, previewUrls],
  );

  const registerEditor = useCallback(
    (nodeKey: string, session: PromptContentEditorSession | null) => {
      promptModule.adoptEditor(nodeKey, session);
    },
    [promptModule],
  );

  const addMaterial = (material: EditableMaterial) => {
    setMaterials((current) =>
      current.some((entry) => sameMaterialTarget(entry.target, material.target))
        ? current
        : [...current, material],
    );
    setUrlError(null);
  };

  const removeMaterial = (material: EditableMaterial) => {
    setMaterials((current) => current.filter((entry) => entry.id !== material.id));
    // 同步移除编辑器中对应素材的引用 chip，避免残留孤立引用。
    const view = promptModule.read(PROMPT_EDITOR_KEY);
    if (view == null) return;
    const kept = view.document.items.filter(
      (item) =>
        item.kind !== "media_reference" || !sameMaterialTarget(item.target, material.target),
    );
    if (kept.length === view.document.items.length) return;
    promptModule.restoreAll({ [PROMPT_EDITOR_KEY]: { ...view.document, items: kept } });
  };

  const addUrlMaterial = () => {
    const url = urlValue.trim();
    const name = urlName.trim() || url;
    if (!url) {
      setUrlError("请填写链接地址。");
      return;
    }
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error();
    } catch {
      setUrlError("链接必须是 http(s) 开头的公开地址。");
      return;
    }
    if (!name) {
      setUrlError("请填写素材名称。");
      return;
    }
    addMaterial({
      id: newMaterialId(),
      target: { kind: "url", url, mediaType: urlKind },
      role: urlRole.trim(),
      displayName: name,
    });
    setUrlValue("");
    setUrlName("");
    setUrlRole("");
  };

  const handleSubmit = () => {
    if (busy) return;
    setValidationError(null);
    if (frozen == null) {
      setValidationError("该任务缺少可用的请求快照，无法重新生成。");
      return;
    }
    // 与画布节点一致：素材作为输入连接，提示词引用从编辑器文档解析，
    // 媒体编号按素材顺序重建 typePosition/contentIndex。
    const connections: PromptContentConnection[] = materials.map((material) => ({
      key: `history-material-${material.id}`,
      name: material.displayName,
      kind: material.target.mediaType,
      target: editorTargetForMaterial(material),
      ...(material.role ? { role: material.role } : {}),
    }));
    const operationSchema = isRecord(task.logicalRequest)
      ? isRecord(task.logicalRequest["modelOperationSchemaSnapshot"])
        ? (task.logicalRequest["modelOperationSchemaSnapshot"] as ModelOperationSchema)
        : null
      : null;
    const prepared = promptModule.prepareGeneration(PROMPT_EDITOR_KEY, {
      connections,
      allowMediaOnly:
        operationSchema != null
          ? modelAllowsMediaOnlyPrompt(operationSchema, frozen.operation)
          : false,
    });
    if (prepared == null || !prepared.ok) {
      const issue = prepared?.issues[0] ?? ({ kind: "empty_prompt" } as const);
      setValidationError(describePreparationIssue(issue));
      return;
    }
    void onSubmit({
      canvasId: frozen.canvasId,
      sourceNodeId: frozen.sourceNodeId,
      operation: frozen.operation,
      providerConnectionId: frozen.providerConnectionId,
      modelDefinitionId: frozen.modelDefinitionId,
      prompt: prepared.frozen.segments,
      explicitMedia: prepared.frozen.explicitMedia,
      ...(frozen.parameters ? { parameters: frozen.parameters } : {}),
      ...(frozen.generationCount != null ? { generationCount: frozen.generationCount } : {}),
    });
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    onCancel();
  };

  const shownError = validationError ?? error;

  return (
    <div className="history-layer regenerate-layer">
      <button
        type="button"
        className="history-backdrop"
        aria-label="关闭重新生成设置"
        onClick={onCancel}
      />
      <section
        className="regenerate-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="regenerate-dialog-title"
        onKeyDown={handleKeyDown}
      >
        <header className="regenerate-dialog__header">
          <span className="history-dialog__eyebrow">生成任务历史</span>
          <h2 id="regenerate-dialog-title">修改后重新生成</h2>
          <p>
            编辑原任务的提示词与素材后创建一次全新生成；原任务记录保持不变，新任务会出现在任务列表中。
          </p>
          <button
            type="button"
            className="history-dialog__close"
            aria-label="关闭重新生成设置"
            onClick={onCancel}
          >
            <X size={18} weight="bold" aria-hidden="true" />
          </button>
        </header>
        <div className="regenerate-dialog__body">
          <div className="regenerate-field">
            <span className="regenerate-field__label" id="regenerate-prompt-label">
              提示词
            </span>
            <PromptMentionInput
              nodeKey={PROMPT_EDITOR_KEY}
              candidates={candidates}
              registerInput={registerEditor}
              labelledBy="regenerate-prompt-label"
              describedBy="regenerate-prompt-hint"
            />
            <span className="regenerate-field__hint" id="regenerate-prompt-hint">
              输入 @
              引用素材；未引用的素材仍会作为输入传入。点击「识别素材名」可把正文中的素材名称转换为引用。
            </span>
          </div>

          <div className="regenerate-materials">
            <div className="regenerate-materials__head">
              <span>素材（{materials.length}）</span>
            </div>
            {materials.length === 0 ? (
              <p className="regenerate-empty-note">该任务没有记录素材，可点击下方添加。</p>
            ) : (
              <ul className="regenerate-materials__list">
                {materials.map((material) => (
                  <li key={material.id} className="regenerate-material">
                    <MaterialThumb
                      previewUrl={previewUrls.get(material.id) ?? null}
                      mediaType={material.target.mediaType}
                    />
                    <span className="regenerate-material__main">
                      <span className="regenerate-material__name" title={material.displayName}>
                        {material.displayName}
                      </span>
                      <span className="regenerate-material__meta">
                        {targetSourceLabel(material.target)} · {materialKindLabel(material)}
                        {material.role ? (
                          <>
                            {" "}
                            ·{" "}
                            <span className="regenerate-material__role">
                              {materialRoleLabel(material.role)}
                            </span>
                          </>
                        ) : null}
                      </span>
                    </span>
                    <button
                      type="button"
                      className="regenerate-material__remove"
                      aria-label={`移除素材 ${material.displayName}`}
                      title="移除素材"
                      disabled={busy}
                      onClick={() => removeMaterial(material)}
                    >
                      <X size={13} weight="bold" aria-hidden="true" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <details className="regenerate-add">
              <summary>
                <Plus size={14} weight="bold" aria-hidden="true" />
                添加素材
              </summary>
              <div className="regenerate-add__tabs" role="tablist" aria-label="素材来源">
                {ADD_TABS.map((tab) => (
                  <button
                    type="button"
                    key={tab.id}
                    role="tab"
                    aria-selected={addTab === tab.id}
                    className={`regenerate-add__tab${addTab === tab.id ? " is-active" : ""}`}
                    onClick={() => setAddTab(tab.id)}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>
              <div className="regenerate-add__body">
                {addTab === "cloud" ? (
                  !runtime ? (
                    <p className="regenerate-add__error">云端素材库需要桌面应用运行环境。</p>
                  ) : cloudError ? (
                    <p className="regenerate-add__error">{cloudError}</p>
                  ) : cloudAssets == null ? (
                    <p className="regenerate-add__empty">正在加载云端素材…</p>
                  ) : cloudAssets.length === 0 ? (
                    <p className="regenerate-add__empty">云端素材库为空。</p>
                  ) : (
                    <ul className="regenerate-add__list">
                      {cloudAssets.map((asset) => (
                        <li key={asset.id}>
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() =>
                              addMaterial({
                                id: newMaterialId(),
                                target: {
                                  kind: "asset",
                                  providerConnectionId: frozen?.providerConnectionId ?? "",
                                  assetId: asset.id,
                                  mediaType: asset.kind,
                                },
                                role: "",
                                displayName: asset.name,
                              })
                            }
                          >
                            <AddListThumb
                              previewUrl={asset.previewUrl ?? asset.coverUrl}
                              kind={asset.kind}
                              renewIdentity={{
                                providerConnectionId: asset.providerConnectionId,
                                assetId: asset.id,
                              }}
                            />
                            <span>{asset.name}</span>
                            <span className="regenerate-add__kind">
                              {MEDIA_TYPE_LABELS[asset.kind] ?? asset.kind}
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )
                ) : null}
                {addTab === "local" ? (
                  !runtime ? (
                    <p className="regenerate-add__error">本地素材库需要桌面应用运行环境。</p>
                  ) : localError ? (
                    <p className="regenerate-add__error">{localError}</p>
                  ) : localAssets == null ? (
                    <p className="regenerate-add__empty">正在加载本地素材…</p>
                  ) : localAssets.length === 0 ? (
                    <p className="regenerate-add__empty">本地素材库为空。</p>
                  ) : (
                    <ul className="regenerate-add__list">
                      {localAssets.map((asset) => (
                        <li key={asset.id}>
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() =>
                              addMaterial({
                                id: newMaterialId(),
                                target: {
                                  kind: "local_asset",
                                  stagingJobId: asset.id,
                                  mediaType: asset.mediaType,
                                },
                                role: "",
                                displayName: asset.name,
                              })
                            }
                          >
                            <AddListThumb previewUrl={asset.previewUrl} kind={asset.mediaType} />
                            <span>{asset.name}</span>
                            <span className="regenerate-add__kind">
                              {MEDIA_TYPE_LABELS[asset.mediaType] ?? asset.mediaType}
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )
                ) : null}
                {addTab === "url" ? (
                  <div className="regenerate-add__url">
                    <label>
                      名称
                      <ImeInput
                        aria-label="链接素材名称"
                        value={urlName}
                        onValueChange={setUrlName}
                        disabled={busy}
                        placeholder="如：参考网页标题"
                      />
                    </label>
                    <label>
                      链接地址
                      <ImeInput
                        aria-label="链接素材地址"
                        value={urlValue}
                        onValueChange={setUrlValue}
                        disabled={busy}
                        placeholder="https://…"
                      />
                    </label>
                    <label>
                      类型
                      <select
                        aria-label="链接素材类型"
                        value={urlKind}
                        disabled={busy}
                        onChange={(event) => setUrlKind(event.target.value as MediaType)}
                      >
                        <option value="image">图片</option>
                        <option value="video">视频</option>
                        <option value="audio">音频</option>
                      </select>
                    </label>
                    <label>
                      角色（可选）
                      <ImeInput
                        aria-label="链接素材角色"
                        value={urlRole}
                        onValueChange={setUrlRole}
                        disabled={busy}
                        placeholder="如：首帧 / 参考图 / 文档 / 网页"
                      />
                    </label>
                    <button
                      type="button"
                      className="regenerate-add__submit"
                      disabled={busy}
                      onClick={addUrlMaterial}
                    >
                      添加链接素材
                    </button>
                    {urlError ? <p className="regenerate-add__error">{urlError}</p> : null}
                  </div>
                ) : null}
              </div>
            </details>
          </div>

          {shownError ? (
            <p role="alert" className="regenerate-dialog__error">
              {shownError}
            </p>
          ) : null}
        </div>
        <footer className="regenerate-dialog__actions">
          <button type="button" disabled={busy} onClick={onCancel}>
            取消
          </button>
          <button
            type="button"
            className="regenerate-dialog__submit"
            disabled={busy}
            onClick={handleSubmit}
          >
            {busy ? "正在创建任务…" : "重新生成"}
          </button>
        </footer>
      </section>
    </div>
  );
}
