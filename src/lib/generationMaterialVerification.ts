import * as v from "valibot";
import { invokeDesktop } from "./ipc";
import type { ExplicitMediaTarget, MediaReferenceTarget, PromptSegment, ExplicitMediaInput } from "./backend";
const verificationSchema = v.object({
  target: v.object({
    kind: v.literal("asset"), providerConnectionId: v.string(), assetId: v.string(),
    mediaType: v.picklist(["image", "video", "audio"]),
    canvasNodeKey: v.optional(v.nullable(v.string())),
  }),
  reused: v.boolean(),
});

/** A verification run is shared by every output in one user submission. No paid request occurs here. */
export async function verifyGenerationMaterials(
  prompt: readonly PromptSegment[],
  explicitMedia: readonly ExplicitMediaInput[],
  providerConnectionId: string | null,
  generation: { providerConnectionId: string; modelDefinitionId: string },
): Promise<{ prompt: readonly PromptSegment[]; explicitMedia: readonly ExplicitMediaInput[] }> {
  const verified = new Map<string, Promise<MediaReferenceTarget>>();
  const verify = (target: ExplicitMediaTarget, displayName: string): Promise<ExplicitMediaTarget> => {
    // Web pages/documents remain explicit remote inputs; the media library does not review them.
    if (target.kind === "url" || target.mediaType === "text") return Promise.resolve(target);
    const key = JSON.stringify(target);
    let pending = verified.get(key);
    if (!pending) {
      pending = invokeDesktop("verify_generation_material", verificationSchema, {
        command: { target, displayName, providerConnectionId, generationProviderConnectionId: generation.providerConnectionId, generationModelDefinitionId: generation.modelDefinitionId },
      }).then((result) => {
        const decoded = result.target;
        if (!decoded.providerConnectionId || !decoded.assetId || decoded.mediaType !== target.mediaType || (decoded.canvasNodeKey ?? null) !== (target.canvasNodeKey ?? null)) {
          throw new Error(`「${displayName}」校验结果中的素材身份不完整，本次没有提交生成。`);
        }
        return {
          kind: "asset" as const,
          providerConnectionId: decoded.providerConnectionId,
          assetId: decoded.assetId,
          mediaType: decoded.mediaType,
          ...(target.canvasNodeKey ? { canvasNodeKey: target.canvasNodeKey } : {}),
        };
      });
      verified.set(key, pending);
    }
    return pending;
  };
  // Bound concurrency and preserve input order, roles and all reference positions.
  const nextPrompt: PromptSegment[] = [];
  for (const segment of prompt) {
    if (segment.kind !== "media_reference") nextPrompt.push(segment);
    else nextPrompt.push({ ...segment, target: await verify(segment.target, segment.displayNameSnapshot) });
  }
  const nextMedia: ExplicitMediaInput[] = [];
  for (const input of explicitMedia) {
    nextMedia.push({ ...input, target: await verify(input.target, input.displayNameSnapshot) });
  }
  return { prompt: nextPrompt, explicitMedia: nextMedia };
}
