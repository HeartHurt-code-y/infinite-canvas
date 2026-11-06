import { convertFileSrc } from "@tauri-apps/api/core";
import { isDesktopRuntime, toMediaSrc } from "./backend";
import type { PromptReferenceCandidate } from "./promptReferences";

/** Preview is presentation data; it never changes the frozen media identity. */
export function promptReferencePreview(candidate: PromptReferenceCandidate): string | null {
  if (candidate.previewUrl) return candidate.previewUrl;
  if (candidate.referenceKind === "local_file") return toMediaSrc(candidate.assetId);
  if (candidate.referenceKind === "local_base64_asset" && isDesktopRuntime()) return convertFileSrc(candidate.assetId, "localbase64");
  return null;
}
