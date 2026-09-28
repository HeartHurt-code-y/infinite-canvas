import type { ProviderCatalogEntry } from "../../../lib/backend";
import type { CanvasDocumentV2 } from "../../canvas/canvasStore";
import { canvasNodesByKeyFromDocument } from "../canvasInputs";
import {
  isTextGenerationModel,
  isVideoGenerationModel,
  type NodeModelSelection,
  type NodeModelSelections,
} from "../workspaceModel";
import type { AgentAction } from "./agentTypes";
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
  return {
    selectedNodeKeys: selected,
    nodes: (Object.keys(lists) as (keyof typeof lists)[]).flatMap((type) =>
      [...lists[type].values()].map((node) => ({
        nodeKey: node.key,
        type,
        x: node.x,
        y: node.y,
        name: "name" in node ? node.name : undefined,
      })),
    ),
    creationNodes: document.genNodes.map((node) => ({
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
    })),
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
      "首版读取画布文字与素材身份，不表示已看过图片或视频。白模采用内置姿态与走位；动作捕捉、工程精修在白模导演台中完成。生成结果需从任务实际状态确认。",
  };
}
