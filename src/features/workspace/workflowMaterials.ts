import type {
  OptimizeVideoPromptCommand,
  PickedPromptMaterial,
  PromptMultimodalInput,
  PromptNodeClient,
} from "../../lib/backend";
import { sameWorkflowSignature, stableJsonSignature } from "../../lib/workflowSignatures";
import type {
  KnowledgeVideoWorkflowCheckpoint,
  KnowledgeVideoWorkflowConfig,
} from "./workspaceModel";

export const MAX_WORKFLOW_MATERIALS = 8;
export const MAX_WORKFLOW_MATERIAL_BYTES = 14 * 1024 * 1024;

export function workflowMaterialPathKey(material: PromptMultimodalInput): string {
  return material.localPath.trim().replaceAll("/", "\\").toLowerCase();
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

export function validateWorkflowMaterials(config: KnowledgeVideoWorkflowConfig): void {
  const materials = workflowReferenceMaterials(config);
  if (materials.length > MAX_WORKFLOW_MATERIALS)
    throw new Error("工作流参考素材（含专用资料）合计最多 8 项。");
  if (
    materials.some((material) => !Number.isFinite(material.byteSize) || material.byteSize <= 0) ||
    materials.reduce((sum, material) => sum + material.byteSize, 0) > MAX_WORKFLOW_MATERIAL_BYTES
  )
    throw new Error("工作流参考素材必须是非空文件，合计不能超过 14 MB。");
}

/** Preserve the call's existing reference order before appending general references. */
export function mergeWorkflowMaterials(
  config: KnowledgeVideoWorkflowConfig,
  extra: readonly PromptMultimodalInput[] = [],
): readonly PromptMultimodalInput[] {
  validateWorkflowMaterials(config);
  const merged = uniqueMaterials([...extra, ...(config.materials ?? [])]);
  if (merged.length > MAX_WORKFLOW_MATERIALS)
    throw new Error("本轮工作流参考素材合计超过 8 项，请减少参考素材后重新制作。");
  return merged.map(({ localPath, displayName, kind, mimeType }) => ({
    localPath,
    displayName,
    kind,
    mimeType,
  }));
}

/** Empty legacy inputs remain resumable; material identities, order, and sizes are significant. */
export function workflowMaterialsSignature(config: KnowledgeVideoWorkflowConfig): string {
  return stableJsonSignature(
    (config.materials ?? []).map(({ localPath, displayName, kind, mimeType, byteSize }) => ({
      localPath,
      displayName,
      kind,
      mimeType,
      byteSize,
    })),
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
      if (!config.materials?.length) return client.run(command);
      return client.run({
        ...command,
        multimodalInputs: mergeWorkflowMaterials(config, command.multimodalInputs),
      });
    },
  };
}
