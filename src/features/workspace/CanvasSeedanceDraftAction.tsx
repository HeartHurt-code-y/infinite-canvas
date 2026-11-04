import { useEffect, useRef, useState } from "react";
import { ErrorAlert } from "../../components/ErrorAlert";
import { generationClient, type GenerationTaskSummary } from "../../lib/backend";
import { canPromoteSeedanceDraft, isSeedanceDraftModel, isSeedanceDraftTask, seedanceDraftPromotionProblem } from "../../lib/seedanceDraft";
import { LibTVMediaIcon } from "./LibTVMediaIcon";
import "./CanvasSeedanceDraftAction.css";

/** Eligibility comes from the displayed result's archived task, never the node's current settings. */
export function CanvasSeedanceDraftAction({ taskId, tasks, onPromote, onOpenTask }: {
  readonly taskId: string;
  readonly tasks: readonly GenerationTaskSummary[];
  readonly onPromote: (taskId: string) => Promise<string>;
  readonly onOpenTask: (taskId: string) => void;
}) {
  const [eligible, setEligible] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [finalTaskId, setFinalTaskId] = useState<string | null>(null);
  const submitting = useRef(false);
  const task = tasks.find(task => task.id === taskId);
  const finalStatus = tasks.find(task => task.id === finalTaskId)?.status;
  const candidate = task == null || isSeedanceDraftModel(task.remoteModelIdSnapshot ?? "");

  useEffect(() => {
    let alive = true;
    if (candidate) void generationClient.getProgress(taskId).then(async progress => {
      if (!isSeedanceDraftTask(progress) && progress.summary.adapterIdSnapshot != null) return;
      if (progress.summary.status !== "succeeded") return;
      // Inspect the actual supplier response once for completed sample candidates, never poll detail.
      const archived = await generationClient.get(taskId);
      if (alive) {
        setEligible(canPromoteSeedanceDraft(archived));
        setProblem(seedanceDraftPromotionProblem(archived));
      }
    }).catch(() => { /* The existing task-history entry remains available. */ });
    return () => { alive = false; };
  }, [candidate, task?.status, taskId]);

  useEffect(() => {
    let alive = true;
    if (finalTaskId && (finalStatus === "failed" || finalStatus === "unknown")) {
      // Read once when the shared task list reports failure; do not add another polling loop.
      void generationClient.getProgress(finalTaskId).then(progress => {
        if (alive && progress.finalError != null) setError(progress.finalError);
      }).catch(() => {});
    }
    return () => { alive = false; };
  }, [finalStatus, finalTaskId]);

  if (!eligible && !problem) return null;

  const promote = async () => {
    if (submitting.current || finalTaskId) return;
    submitting.current = true;
    setBusy(true);
    setError(null);
    try {
      setFinalTaskId(await onPromote(taskId));
    } catch (cause) {
      setError(cause);
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };

  return <div className="canvas-seedance-draft nodrag nopan"
    onPointerDown={event => event.stopPropagation()}
    onMouseDown={event => event.stopPropagation()}
    onClick={event => event.stopPropagation()}>
    <div className="canvas-seedance-draft__actions">
      <span>{problem ? "样片未生效" : "样片"}</span>
      {finalTaskId ? <button type="button" onClick={() => onOpenTask(finalTaskId)}>查看正片任务</button>
        : problem ? <button type="button" onClick={() => onOpenTask(taskId)}>查看任务</button>
        : <button type="button" disabled={busy} onClick={() => void promote()}
          aria-label="样片已确认，生成 1080p 正片"
          data-tooltip="确认样片后创建独立付费任务，保留原样片。">
          <LibTVMediaIcon name={busy ? "icon-loading" : "hd"} size={14} className={busy ? "spin-icon" : ""} />
          {busy ? "提交正片中…" : "生成 1080P 正片"}
        </button>}
    </div>
    {error != null || problem ? <ErrorAlert error={error ?? problem} variant="inline" /> : null}
  </div>;
}
