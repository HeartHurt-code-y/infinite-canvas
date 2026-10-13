import type { GenerationTaskDetail } from "./backend";

export const SEEDANCE_DRAFT_MODEL_ID = "doubao-seedance-2-5-260628";
export const SEEDANCE_DRAFT_PROFILE_ID = "moyu_seedance_25_draft_v1";

/** Both catalog IDs use the same draft contract; preserve the selected remote ID. */
export function isSeedanceDraftModel(modelId: string): boolean {
  const normalized = modelId.toLowerCase();
  return normalized === SEEDANCE_DRAFT_MODEL_ID || normalized === "doubao-seedance-2.5";
}

export function supportsSeedanceDraft(adapterId: string, modelId: string): boolean {
  return adapterId === "moyu_v1" && isSeedanceDraftModel(modelId);
}

function record(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Use the task's archived dialect and request, never the current provider settings. */
export function isSeedanceDraftTask(detail: GenerationTaskDetail): boolean {
  if (detail.summary.operation !== "video_generation") return false;
  const logical = record(detail.logicalRequest);
  const resolved = record(detail.resolvedRequest);
  const parameters = record(logical?.["parameters"]) ?? record(resolved?.["parameters"]);
  const logicalDraft = parameters?.["draft"] === true;
  return detail.calls.some((call) => {
    const request = record(call.request);
    const adapterId = request?.["adapterId"];
    if (
      call.phase !== "submit" ||
      !supportsSeedanceDraft(
        typeof adapterId === "string" ? adapterId : "",
        detail.summary.remoteModelIdSnapshot ?? "",
      )
    ) {
      return false;
    }
    const body = record(request?.["body"]);
    return logicalDraft || record(body?.["metadata"])?.["draft"] === true;
  });
}

export function canPromoteSeedanceDraft(detail: GenerationTaskDetail): boolean {
  return (
    isSeedanceDraftTask(detail) &&
    detail.summary.status === "succeeded" &&
    Boolean(detail.summary.remoteTaskId?.trim())
  );
}

/** Local parent identity links the final task back to its preserved draft result. */
export function seedanceDraftSourceTaskId(detail: GenerationTaskDetail): string | null {
  const value = record(detail.logicalRequest)?.["seedanceDraftSourceTaskId"];
  return typeof value === "string" && value.trim() ? value : null;
}
