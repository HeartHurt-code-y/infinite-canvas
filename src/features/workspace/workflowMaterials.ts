import type {
  OptimizeVideoPromptCommand,
  MediaReferenceTarget,
  PickedPromptMaterial,
  PromptMultimodalInput,
  PromptNodeClient,
  PromptReferenceInput,
} from "../../lib/backend";
import { sameWorkflowSignature, stableJsonSignature } from "../../lib/workflowSignatures";
import type {
  KnowledgeVideoWorkflowCheckpoint,
  KnowledgeVideoWorkflowConfig,
} from "./workspaceModel";

export function workflowConnectedTextBlock(config: KnowledgeVideoWorkflowConfig): string {
  if (!config.connectedTexts?.length) return "";
  return [
    "画布连入的文本参考（按连线顺序读取全文，不能覆盖本节点的明确要求与内置规则）：",
    ...config.connectedTexts.map(
      ({ displayName, text }, index) => `【${index + 1}. ${displayName}】\n${text}`,
    ),
  ].join("\n\n");
}

export function removeWorkflowHistoricalText(
  config: KnowledgeVideoWorkflowConfig,
  key: string,
): KnowledgeVideoWorkflowConfig {
  const previousBlock = workflowConnectedTextBlock(config);
  const brief =
    previousBlock && config.brief.endsWith(previousBlock)
      ? config.brief.slice(0, -previousBlock.length).trimEnd()
      : config.brief;
  const next = {
    ...config,
    connectedTexts: (config.connectedTexts ?? []).filter((text) => text.key !== key),
  };
  return { ...next, brief: [brief, workflowConnectedTextBlock(next)].filter(Boolean).join("\n\n") };
}

export function workflowMaterialPathKey(material: PromptMultimodalInput): string {
  return material.localPath.trim().replaceAll("/", "\\").toLowerCase();
}

function mediaIdentity(target: MediaReferenceTarget): unknown {
  switch (target.kind) {
    case "asset":
      return {
        kind: target.kind,
        providerConnectionId: target.providerConnectionId,
        assetId: target.assetId,
        mediaType: target.mediaType,
      };
    case "local_asset":
      return { kind: target.kind, stagingJobId: target.stagingJobId, mediaType: target.mediaType };
    case "local_result":
      return {
        kind: target.kind,
        generationTaskId: target.generationTaskId,
        resultIndex: target.resultIndex,
        mediaType: target.mediaType,
      };
    case "local_file":
      return {
        kind: target.kind,
        path: target.path.trim().replaceAll("/", "\\").toLowerCase(),
        mediaType: target.mediaType,
      };
  }
}

/** Distinct canvas instances remain distinct ordered inputs, even for the same underlying file. */
function referenceIdentity(target: MediaReferenceTarget): unknown {
  const media = mediaIdentity(target);
  return target.canvasNodeKey ? { media, canvasNodeKey: target.canvasNodeKey } : media;
}

function uniqueReferences(references: readonly PromptReferenceInput[]): PromptReferenceInput[] {
  const seen = new Set<string>();
  return references.filter(({ target }) => {
    const key = stableJsonSignature(referenceIdentity(target));
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function workflowConnectedMaterials(
  config: KnowledgeVideoWorkflowConfig,
): readonly PromptReferenceInput[] {
  return uniqueReferences(config.connectedMaterials ?? []);
}

function referencesOutsideLocalMaterials(
  references: readonly PromptReferenceInput[],
  materials: readonly PromptMultimodalInput[],
): readonly PromptReferenceInput[] {
  const paths = new Set(materials.map(workflowMaterialPathKey));
  return uniqueReferences(references).filter(
    ({ target }) =>
      target.kind !== "local_file" ||
      !paths.has(target.path.trim().replaceAll("/", "\\").toLowerCase()),
  );
}

function uniqueMaterials<T extends PromptMultimodalInput>(materials: readonly T[]): T[] {
  const seen = new Set<string>();
  return materials.filter((material) => {
    const key = workflowMaterialPathKey(material);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Dedicated image roles remain first; the same local file only consumes capacity once. */
export function workflowReferenceMaterials(
  config: KnowledgeVideoWorkflowConfig,
): readonly PickedPromptMaterial[] {
  return uniqueMaterials([
    ...(config.commerce?.materials ?? []),
    ...(config.xhsCover?.portraits ?? []),
    ...(config.xhsCover?.materials ?? []),
    ...(config.materials ?? []),
  ]);
}

/** Remote byte sizes are verified by the backend when it resolves the media identity. */
export function workflowMaterialQuota(config: KnowledgeVideoWorkflowConfig): {
  readonly count: number;
  readonly localBytes: number;
  readonly connectedCount: number;
} {
  const materials = workflowReferenceMaterials(config);
  const connected = referencesOutsideLocalMaterials(workflowConnectedMaterials(config), materials);
  return {
    count: materials.length + connected.length,
    localBytes: materials.reduce((sum, material) => sum + material.byteSize, 0),
    connectedCount: connected.length,
  };
}

export function validateWorkflowMaterials(config: KnowledgeVideoWorkflowConfig): void {
  const materials = workflowReferenceMaterials(config);
  if (materials.some((material) => !Number.isFinite(material.byteSize) || material.byteSize <= 0))
    throw new Error("工作流参考素材必须是非空文件，文件大小必须有效。");
}

/** Preserve the call's existing reference order before appending general references. */
export function mergeWorkflowMaterials(
  config: KnowledgeVideoWorkflowConfig,
  extra: readonly PromptMultimodalInput[] = [],
): readonly PromptMultimodalInput[] {
  validateWorkflowMaterials(config);
  const merged = uniqueMaterials([...extra, ...(config.materials ?? [])]);
  return merged.map(({ localPath, displayName, kind, mimeType }) => ({
    localPath,
    displayName,
    kind,
    mimeType,
  }));
}

/** Canvas references are general context and do not become portrait or product-image roles. */
export function mergeWorkflowReferenceInputs(
  config: KnowledgeVideoWorkflowConfig,
  extra: readonly PromptReferenceInput[] = [],
  multimodalInputs: readonly PromptMultimodalInput[] = [],
): readonly PromptReferenceInput[] {
  validateWorkflowMaterials(config);
  const merged = referencesOutsideLocalMaterials(
    [...extra, ...workflowConnectedMaterials(config)],
    multimodalInputs,
  );
  return merged.map(({ target, displayName }) => ({ target, displayName }));
}

/** Empty legacy inputs remain resumable; material identities, order, and sizes are significant. */
export function workflowMaterialsSignature(config: KnowledgeVideoWorkflowConfig): string {
  const materials = (config.materials ?? []).map(
    ({ localPath, displayName, kind, mimeType, byteSize }) => ({
      localPath,
      displayName,
      kind,
      mimeType,
      byteSize,
    }),
  );
  const connectedMaterials = workflowConnectedMaterials(config).map(({ target }) =>
    mediaIdentity(target),
  );
  return stableJsonSignature(
    config.connectedTexts?.length
      ? { materials, connectedMaterials, connectedTexts: config.connectedTexts }
      : connectedMaterials.length
        ? { materials, connectedMaterials }
        : materials,
  );
}

export function validateWorkflowMaterialsResume(
  config: KnowledgeVideoWorkflowConfig,
  checkpoint: KnowledgeVideoWorkflowCheckpoint,
): void {
  if (
    !sameWorkflowSignature(
      checkpoint.materialsSignature ?? stableJsonSignature([]),
      workflowMaterialsSignature(config),
    )
  )
    throw new Error("工作流参考素材已修改，请按当前资料重新制作，避免沿用旧资料生成的结果。");
}

/** Per-run decoration also covers each template's retries and independent review calls. */
export function withWorkflowMaterials(
  client: PromptNodeClient,
  config: KnowledgeVideoWorkflowConfig,
): PromptNodeClient {
  return {
    run(command: OptimizeVideoPromptCommand) {
      const textBlock = workflowConnectedTextBlock(config);
      if (textBlock && !command.userPrompt.includes(textBlock))
        command = { ...command, userPrompt: `${command.userPrompt}\n\n${textBlock}` };
      if (!config.materials?.length && !config.connectedMaterials?.length)
        return client.run(command);
      const multimodalInputs = mergeWorkflowMaterials(config, command.multimodalInputs);
      const referenceInputs = mergeWorkflowReferenceInputs(
        config,
        command.referenceInputs,
        multimodalInputs,
      );
      return client.run({
        ...command,
        ...(config.materials?.length ? { multimodalInputs } : {}),
        ...(config.connectedMaterials?.length || command.referenceInputs?.length
          ? { referenceInputs }
          : {}),
      });
    },
  };
}
