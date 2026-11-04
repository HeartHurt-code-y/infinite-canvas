import type { GenerationTaskDetail, GenerationTaskProgress } from "./backend";

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
export function isSeedanceDraftTask(detail: GenerationTaskDetail | GenerationTaskProgress): boolean {
  if (detail.summary.operation !== "video_generation") return false;
  const logical = record(detail.logicalRequest);
  const resolved = "resolvedRequest" in detail ? record(detail.resolvedRequest) : null;
  const parameters = record(logical?.["parameters"]) ?? record(resolved?.["parameters"]);
  const logicalDraft = parameters?.["draft"] === true;
  /*
   * 适配器身份取任务快照；快照缺失（旧后端）时回退到请求体。
   *
   * 快照是权威：请求体可能整包带 base64 素材，详情接口只回片段
   * （body.metadata 正好落在被省略的那一半时就读不到）。
   * 但开发环境的前后端可能不同步，旧后端没有这个快照字段——那就仍从
   * 请求体里取，两条路任选其一都能认出草稿任务。
   */
  const snapshotAdapterId = detail.summary.adapterIdSnapshot;
  if (logicalDraft && supportsSeedanceDraft(snapshotAdapterId ?? "", detail.summary.remoteModelIdSnapshot ?? "")) return true;
  return "calls" in detail && detail.calls.some((call) => {
    const request = record(call.request);
    const requestAdapterId = request?.["adapterId"];
    const adapterId =
      snapshotAdapterId ?? (typeof requestAdapterId === "string" ? requestAdapterId : "");
    if (
      call.phase !== "submit" ||
      !supportsSeedanceDraft(adapterId, detail.summary.remoteModelIdSnapshot ?? "")
    ) {
      return false;
    }
    const body = record(request?.["body"]);
    return logicalDraft || record(body?.["metadata"])?.["draft"] === true;
  });
}

/** A requested draft is only reusable when the supplier confirms its actual mode. */
export function seedanceDraftPromotionProblem(detail: GenerationTaskDetail | GenerationTaskProgress): string | null {
  if (!isSeedanceDraftTask(detail) || detail.summary.status !== "succeeded") return null;
  let mode: boolean | null = null;
  if ("calls" in detail) {
    // Only the final successful observation is authoritative; submit requests can be echoed.
    const call = [...detail.calls].reverse().find(call =>
      call.phase === "observe" && call.httpStatus != null && call.httpStatus >= 200 && call.httpStatus < 300 && call.rawResponse != null);
    try {
      let payload: unknown = call?.rawResponse ? JSON.parse(call.rawResponse) : null;
      for (let depth = 0; depth < 8; depth++) {
        const envelope = record(payload);
        if (!envelope) break;
        if (typeof envelope["draft"] === "boolean") mode = envelope["draft"];
        payload = envelope["data"];
      }
    } catch { /* Truncated or missing observations cannot confirm a reusable draft. */ }
  }
  if (mode === false) return "供应商返回的是普通视频（draft:false），没有生成可复用的样片，不能转正片。原视频已保留；请联系该供应商核对样片支持，或在清晰度中选择 1080P 直接生成。";
  if (mode !== true) return "供应商未确认样片身份，暂不能转正片。原视频已保留，请在任务详情中核对供应商返回。";
  if (!detail.summary.remoteTaskId?.trim()) return "草稿样片缺少有效的远程任务 ID。";
  return null;
}

export function canPromoteSeedanceDraft(detail: GenerationTaskDetail | GenerationTaskProgress): boolean {
  return (
    isSeedanceDraftTask(detail) &&
    detail.summary.status === "succeeded" &&
    Boolean(detail.summary.remoteTaskId?.trim()) &&
    seedanceDraftPromotionProblem(detail) == null
  );
}

/** Local parent identity links the final task back to its preserved draft result. */
export function seedanceDraftSourceTaskId(detail: GenerationTaskDetail): string | null {
  const value = record(detail.logicalRequest)?.["seedanceDraftSourceTaskId"];
  return typeof value === "string" && value.trim() ? value : null;
}
