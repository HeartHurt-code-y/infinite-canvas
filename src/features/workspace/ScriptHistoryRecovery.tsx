import { useState } from "react";
import { CanvasSelect } from "../../components/CanvasSelect";
import { ErrorAlert } from "../../components/ErrorAlert";
import { generationClient, isDesktopRuntime, type GenerationTaskCursor, type GenerationTaskDetail } from "../../lib/backend";

const time = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
});

function scriptRequest(detail: GenerationTaskDetail): "生成分镜" | "合成提示词" | null {
  const request = detail.logicalRequest;
  if (!request || typeof request !== "object" || Array.isArray(request)) return null;
  const value = request as Record<string, unknown>;
  if (value["scriptGenerator"] === true) return "生成分镜";
  if (value["scriptPromptCompose"] === true) return "合成提示词";
  return null;
}

export function ScriptHistoryRecovery({ canvasId, nodeKey, running, onRestore }: {
  readonly canvasId: string;
  readonly nodeKey: string;
  readonly running: boolean;
  readonly onRestore: (detail: GenerationTaskDetail) => void;
}) {
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [items, setItems] = useState<readonly GenerationTaskDetail[]>([]);
  const [nextCursor, setNextCursor] = useState<GenerationTaskCursor | null>(null);
  const [selected, setSelected] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [restored, setRestored] = useState(false);
  const load = async (append = false) => {
    if (loading) return;
    if (append && !nextCursor) return;
    if (!isDesktopRuntime()) { setError("任务历史只能在桌面应用中读取。"); return; }
    setLoading(true);
    setError(null);
    setRestored(false);
    try {
      const page = await generationClient.list({ canvasId, sourceNodeId: nodeKey, statuses: ["succeeded"], limit: 40,
        ...(append && nextCursor ? { cursor: nextCursor } : {}) });
      const tasks = page.items.filter((task) => task.operation === "text_generation" && task.canvasId === canvasId && task.sourceNodeId === nodeKey);
      const results = await Promise.allSettled(tasks.map((task) => generationClient.get(task.id)));
      const details = results.flatMap((result) => result.status === "fulfilled" && result.value.textOutput &&
        result.value.summary.canvasId === canvasId && result.value.summary.sourceNodeId === nodeKey &&
        scriptRequest(result.value) ? [result.value] : []);
      setItems((current) => {
        if (!append) return details;
        const existing = new Set(current.map((item) => item.summary.id));
        return [...current, ...details.filter((item) => !existing.has(item.summary.id))];
      });
      setNextCursor(page.nextCursor);
      setSelected((current) => append && current ? current
        : details.some((item) => item.summary.id === current) ? current : details[0]?.summary.id ?? "");
      setLoaded(true);
      if (results.some((result) => result.status === "rejected")) setError("部分任务详情读取失败，请重新读取历史。");
    } catch (cause) { setError(cause); }
    finally { setLoading(false); }
  };
  const selectedTask = items.find((item) => item.summary.id === selected);
  return <details className="canvas-script-editor__history">
    <summary>从任务历史恢复</summary>
    <p>只读取本节点的已完成任务，不会再次请求模型。恢复会替换当前分镜或对应镜头提示词，可撤回一次。</p>
    <button type="button" disabled={loading || running} onClick={() => { void load(); }}>
      {loading ? "读取中…" : loaded ? "刷新历史" : "读取历史"}
    </button>
    {loaded && !items.length ? <p>{nextCursor ? "已读取的任务中没有可恢复的分镜结果，可继续读取更早的任务。" : "没有找到可恢复的分镜结果。"}</p> : null}
    {items.length ? <div className="canvas-script-editor__history-select">
      <CanvasSelect ariaLabel="选择要恢复的脚本任务" value={selected} options={items.map((item) => ({
        value: item.summary.id, label: `${time.format(new Date(item.summary.createdAt))} · ${scriptRequest(item)} · ${item.summary.remoteModelIdSnapshot ?? "文本模型"}`,
      }))} onChange={(value) => { setSelected(value); setRestored(false); }} disabled={loading || running} />
      <button type="button" disabled={!selectedTask || running} onClick={() => {
        if (!selectedTask) return;
        try { onRestore(selectedTask); setError(null); setRestored(true); }
        catch (cause) { setError(cause); }
      }}>恢复所选结果</button>
    </div> : null}
    {nextCursor ? <button type="button" disabled={loading || running} onClick={() => { void load(true); }}>读取更早的任务</button> : null}
    {selectedTask?.textOutput ? <details><summary>查看模型结果</summary><pre>{selectedTask.textOutput.optimizedPrompt}</pre></details> : null}
    {restored ? <p role="status">已恢复所选结果，请核对内容。</p> : null}
    {error ? <ErrorAlert error={error} hint="检查任务历史后重试；读取历史不会重新生成。" /> : null}
  </details>;
}
