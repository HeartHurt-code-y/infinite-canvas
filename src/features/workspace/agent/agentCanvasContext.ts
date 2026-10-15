import type {
  ConfiguredModel,
  GenerationOperation,
  ProviderCatalogEntry,
} from "../../../lib/backend";
import {
  modelParameterCapabilities,
  type ModelParameterCapability,
} from "../../../lib/modelCapabilities";
import type { CanvasDocumentV2 } from "../../canvas/canvasStore";
import { canvasNodesByKeyFromDocument, createCanvasInputResolver } from "../canvasInputs";
import {
  isTextGenerationModel,
  isVideoGenerationModel,
  type NodeModelSelection,
  type NodeModelSelections,
  type ScreenplayNodeData,
  type StoryboardNodeData,
} from "../workspaceModel";
import type { AgentAction } from "./agentTypes";
import { agentDownloadTargetUrl } from "./agentVideoDownloadTools";
import { stableJsonSignature } from "../../../lib/workflowSignatures";

/** React Flow measurements and camera pan are UI observations, not changes to an approved plan. */
export function agentCanvasSignature(
  document: CanvasDocumentV2,
  catalog: readonly ProviderCatalogEntry[],
) {
  const withoutMeasurements = <T extends { readonly key: string }>(nodes: readonly T[]) =>
    nodes.map((node) => ({ ...node, measured: undefined }));
  return stableJsonSignature({
    ...document,
    agent: undefined,
    view: undefined,
    assetNodes: withoutMeasurements(document.assetNodes),
    genNodes: withoutMeasurements(document.genNodes),
    screenplayNodes: withoutMeasurements(document.screenplayNodes ?? []),
    storyboardNodes: withoutMeasurements(document.storyboardNodes ?? []),
    knowledgeVideoWorkflowNodes: withoutMeasurements(document.knowledgeVideoWorkflowNodes ?? []),
    viralRemixNodes: withoutMeasurements(document.viralRemixNodes ?? []),
    videoComposerNodes: withoutMeasurements(document.videoComposerNodes ?? []),
    videoDownloaderNodes: withoutMeasurements(document.videoDownloaderNodes ?? []),
    frameExtractorNodes: withoutMeasurements(document.frameExtractorNodes ?? []),
    resultNodes: withoutMeasurements(document.resultNodes),
    outputNodes: withoutMeasurements(document.outputNodes ?? []),
    modelRoutes: catalog.map(({ provider, models }) => ({
      id: provider.id,
      enabled: provider.enabled,
      baseUrl: provider.baseUrl,
      models,
    })),
  });
}

const nodeTypeLabels: Record<
  Exclude<keyof ReturnType<typeof canvasNodesByKeyFromDocument>, "gen">,
  string
> = {
  asset: "素材节点",
  screenplay: "剧本节点",
  storyboard: "分镜节点",
  knowledgeVideoWorkflow: "知识视频节点",
  viralRemix: "爆款复刻节点",
  videoComposer: "视频合成节点",
  videoDownloader: "视频下载节点",
  frameExtractor: "视频抽帧节点",
  result: "结果节点",
  output: "输出节点",
};

/** 智能体删除评审与 create_node 评审共用的节点种类称谓。 */
const createKindLabels: Readonly<Record<string, string>> = {
  image: "图片节点",
  video: "视频节点",
  prompt: "提示词节点",
  screenplay: "剧本节点",
  storyboard: "分镜节点",
  video_composer: "视频合成节点",
  frame_extractor: "视频抽帧节点",
};

/**
 * 节点当前模型在当前操作下声明的参数能力；上下文展示与智能体写入校验共用一份口径。
 * 图片节点按是否已有媒体输入区分文生图/图生视频，与节点设置页同一判定；
 * hasMediaInputs 缺省时按文档连线现算。节点不是图片/视频生成节点、或模型不可用时返回 null。
 */
export function agentGenNodeParameterCapabilities(
  document: CanvasDocumentV2,
  catalog: readonly ProviderCatalogEntry[],
  nodeKey: string,
  hasMediaInputs?: boolean,
): {
  operation: GenerationOperation;
  model: ConfiguredModel;
  capabilities: readonly ModelParameterCapability[];
} | null {
  const node = document.genNodes.find((item) => item.key === nodeKey);
  if (!node || node.kind === "prompt") return null;
  const model = catalog
    .find(
      (entry) =>
        entry.provider.enabled && entry.provider.id === node.config.modelSelection.providerId,
    )
    ?.models.find((item) => item.definitionId === node.config.modelSelection.modelDefinitionId);
  if (!model) return null;
  const mediaInputs =
    hasMediaInputs ??
    createCanvasInputResolver(canvasNodesByKeyFromDocument(document), document.assetEdges)(nodeKey)
      .media.length > 0;
  const operation: GenerationOperation =
    node.kind === "video" ? "video_generation" : mediaInputs ? "image_to_image" : "text_to_image";
  return {
    operation,
    model,
    capabilities: modelParameterCapabilities(model.operationSchema, operation, model.remoteModelId),
  };
}

/** 上下文里的参数能力摘要：键、中文名、类型、默认值、可选值与数值边界。 */
const parameterOptionView = (capability: ModelParameterCapability) => ({
  key: capability.key,
  label: capability.label,
  type: capability.type,
  default: capability.defaultValue,
  options: capability.options.map((option) => option.value),
  minimum: capability.minimum ?? null,
  maximum: capability.maximum ?? null,
});

/** Build the generation review from real node inputs plus validated preceding plan edits. */
export function agentPlanReview(
  document: CanvasDocumentV2,
  catalog: readonly ProviderCatalogEntry[],
  defaults: NodeModelSelections,
  actions: readonly AgentAction[],
): string[] {
  const nodes = new Map<
    string,
    {
      kind: "image" | "video" | "prompt";
      model: NodeModelSelection;
      text: string;
      count: number;
      parameters: unknown;
    }
  >();
  for (const node of document.genNodes)
    nodes.set(node.key, {
      kind: node.kind,
      model: node.config.modelSelection,
      text:
        node.kind === "prompt"
          ? node.config.generatedPrompt || node.config.sourcePrompt
          : (document.promptContents[node.key]?.items
              .map((item) => (item.kind === "text" ? item.text : "[已绑定素材引用]"))
              .join("") ?? ""),
      count: node.kind === "prompt" ? 0 : node.config.generationCount,
      parameters: node.kind === "prompt" ? {} : node.config.parameterValues,
    });
  const review: string[] = [];
  const describeDeletedNode = (key: string): string => {
    if (key.startsWith("$")) {
      const index = actions.findIndex((item) => item.id === key.slice(1));
      const kind = index >= 0 ? actions[index]!.args["kind"] : undefined;
      return `第 ${index + 1} 步创建的${
        (typeof kind === "string" ? createKindLabels[kind] : undefined) ?? "目标节点"
      }`;
    }
    const lists = canvasNodesByKeyFromDocument(document);
    const type = (Object.keys(nodeTypeLabels) as (keyof typeof nodeTypeLabels)[]).find(
      (candidate) => lists[candidate].has(key),
    );
    if (type === undefined) {
      const gen = lists.gen.get(key);
      return gen
        ? `${gen.kind === "video" ? "视频" : gen.kind === "image" ? "图片" : "提示词"}创作节点`
        : "目标节点";
    }
    const named = lists[type].get(key);
    const name = named && "name" in named ? named["name"] : undefined;
    return `${nodeTypeLabels[type]}${typeof name === "string" && name ? `「${name}」` : ""}`;
  };
  for (const action of actions) {
    const args = action.args;
    if (action.tool === "canvas.create_node") {
      const kind = args["kind"];
      if (kind === "image" || kind === "video" || kind === "prompt")
        nodes.set(`$${action.id}`, {
          kind,
          model: defaults[kind],
          text: typeof args["text"] === "string" ? args["text"] : "",
          count: 1,
          parameters: {},
        });
    }
    const node = typeof args["nodeKey"] === "string" ? nodes.get(args["nodeKey"]) : undefined;
    if (action.tool === "canvas.delete_node") {
      const key = typeof args["nodeKey"] === "string" ? args["nodeKey"] : "";
      const edges = document.assetEdges.filter(
        (edge) => edge.fromKey === key || edge.toKey === key,
      ).length;
      review.push(
        `将删除${describeDeletedNode(key)}及其 ${edges} 条连线；已保存的媒体与任务历史保留。`,
      );
      continue;
    }
    if (action.tool === "video_download.start") {
      const raw = typeof args["url"] === "string" ? args["url"] : "";
      let url = raw.trim();
      try {
        url = agentDownloadTargetUrl(raw);
      } catch {
        // 无效链接留给计划校验拦截，评审行按原文展示。
      }
      review.push(
        `将下载 ${url} 的视频到本机，完成后作为素材卡片放入画布${
          typeof args["nodeKey"] === "string" ? "并连接到指定节点" : ""
        }。下载不调用生成模型，不产生模型费用。`,
      );
      continue;
    }
    if (action.tool === "canvas.set_document" && typeof args["text"] === "string") {
      review.push(
        `将把剧本或分镜节点的文档整篇替换为新内容（约 ${args["text"].length} 字），原文档不保留。`,
      );
      continue;
    }
    if (
      action.tool === "canvas.set_parameters" &&
      args["parameters"] != null &&
      typeof args["parameters"] === "object"
    ) {
      const parameters = args["parameters"] as Record<string, unknown>;
      if (node) node.parameters = { ...(node.parameters as object), ...parameters };
      review.push(`将设置生成参数：${JSON.stringify(parameters)}。`);
      continue;
    }
    if (action.tool === "frame_extract.run") {
      const timestamps = Array.isArray(args["timestamps"]) ? args["timestamps"] : null;
      review.push(
        `将按${
          timestamps && timestamps.length ? `${timestamps.length} 个时刻` : "节点已配置的秒数"
        }从连线视频抽帧，帧图片逐张落入画布。本机 FFmpeg 处理，不调用生成模型，不产生模型费用。`,
      );
      continue;
    }
    if (action.tool === "video_compose.run") {
      review.push(
        "将按连线顺序把视频合成为一个成片落入画布。本机 FFmpeg 处理，不调用生成模型，不产生模型费用。",
      );
      continue;
    }
    if (!node) continue;
    if (action.tool === "canvas.set_prompt" && typeof args["text"] === "string")
      node.text = args["text"];
    if (
      action.tool === "canvas.set_model" &&
      typeof args["providerId"] === "string" &&
      typeof args["modelDefinitionId"] === "string"
    ) {
      node.model = { providerId: args["providerId"], modelDefinitionId: args["modelDefinitionId"] };
      node.parameters = {};
    }
    if (action.tool === "generation.start") {
      const provider = catalog.find(
        (entry) => entry.provider.id === node.model.providerId && entry.provider.enabled,
      );
      const model = provider?.models.find(
        (item) => item.definitionId === node.model.modelDefinitionId,
      );
      review.push(
        `将提交 ${node.count} 份${node.kind === "video" ? "视频" : "图片"}生成，模型：${model?.displayName ?? "尚未选择可用模型"} · ${provider?.provider.displayName ?? "尚未选择供应商"}。`,
      );
      review.push(
        `节点文字（连接上游文本时按连线合并）：${node.text || "将读取计划连接的上游内容"}`,
      );
      if (Object.keys(node.parameters as object).length)
        review.push(`节点生成参数：${JSON.stringify(node.parameters)}`);
      review.push(
        "参考素材按节点现有连线及本次计划中的连线传入。此操作提交生成任务，结果以画布和任务历史为准。",
      );
    }
  }
  return review;
}

/** Only semantic summaries cross the model interface. Credentials and local paths stay here. */
export function agentCanvasContext(
  document: CanvasDocumentV2,
  catalog: readonly ProviderCatalogEntry[],
  selected: readonly string[],
) {
  const lists = canvasNodesByKeyFromDocument(document);
  const resolver = createCanvasInputResolver(lists, document.assetEdges);
  return {
    selectedNodeKeys: selected,
    nodes: (Object.keys(lists) as (keyof typeof lists)[]).flatMap((type) =>
      [...lists[type].values()].map((node) => {
        // ResultNodeData/OutputNodeData 没有 kind 字段，属性存在性先于判别收窄。
        const kind = (node as { kind?: unknown }).kind;
        const documentText =
          kind === "screenplay" || kind === "storyboard"
            ? (node as ScreenplayNodeData | StoryboardNodeData).config.currentDocument
            : undefined;
        return {
          nodeKey: node.key,
          type,
          x: node.x,
          y: node.y,
          name: "name" in node ? node.name : undefined,
          ...(documentText === undefined ? {} : { document: documentText }),
        };
      }),
    ),
    creationNodes: document.genNodes.map((node) => {
      const capabilities =
        node.kind === "prompt"
          ? null
          : agentGenNodeParameterCapabilities(
              document,
              catalog,
              node.key,
              resolver(node.key).media.length > 0,
            );
      return {
        nodeKey: node.key,
        kind: node.kind,
        model: node.config.modelSelection,
        text:
          node.kind === "prompt"
            ? node.config.generatedPrompt || node.config.sourcePrompt
            : document.promptContents[node.key]?.items
                .map((item) => (item.kind === "text" ? item.text : "[已绑定素材引用]"))
                .join(""),
        hasWhiteModel: node.kind !== "prompt" && !!node.config.whiteModelStudio,
        generationCount: node.kind !== "prompt" ? node.config.generationCount : undefined,
        parameters: node.kind === "prompt" ? undefined : node.config.parameterValues,
        parameterOptions: capabilities
          ? {
              operation: capabilities.operation,
              parameters: capabilities.capabilities.map(parameterOptionView),
            }
          : null,
      };
    }),
    edges: document.assetEdges.map(({ fromKey, toKey }) => ({ fromKey, toKey })),
    models: catalog
      .filter((entry) => entry.provider.enabled)
      .flatMap((entry) =>
        entry.models.map((model) => ({
          providerId: entry.provider.id,
          providerName: entry.provider.displayName,
          modelDefinitionId: model.definitionId,
          name: model.displayName,
          kind: isTextGenerationModel(model)
            ? "prompt"
            : isVideoGenerationModel(model)
              ? "video"
              : "image",
        })),
      ),
    limitations:
      "首版读取画布文字与素材身份，不表示已看过图片或视频。白模采用内置姿态与走位；动作捕捉、工程精修在白模导演台中完成。生成进展用 generation.history 查询任务实际状态确认。",
  };
}
