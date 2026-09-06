import { useId, useState } from "react";
import { parseHistoryDateRange, type HistoryDateRange } from "./historyDateRange";
import "./HistoryDateRangeFilter.css";

export function HistoryDateRangeFilter({
  onApply,
}: {
  readonly onApply: (range: HistoryDateRange) => void;
}) {
  const id = useId();
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="history-date-filter"
      aria-label="按创建时间查询"
      onSubmit={(event) => {
        event.preventDefault();
        try {
          const range = parseHistoryDateRange(from, to);
          setError(null);
          onApply(range);
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : "日期时间无效。");
        }
      }}
    >
      <p id={`${id}-hint`}>按创建时间 · 本机时区，包含结束秒</p>
      <label htmlFor={`${id}-from`}>开始时间</label>
      <input
        id={`${id}-from`}
        type="datetime-local"
        step="1"
        value={from}
        aria-describedby={`${id}-hint${error ? ` ${id}-error` : ""}`}
        aria-invalid={error != null}
        onChange={(event) => {
          setFrom(event.target.value);
          setError(null);
        }}
      />
      <label htmlFor={`${id}-to`}>结束时间</label>
      <input
        id={`${id}-to`}
        type="datetime-local"
        step="1"
        value={to}
        aria-describedby={`${id}-hint${error ? ` ${id}-error` : ""}`}
        aria-invalid={error != null}
        onChange={(event) => {
          setTo(event.target.value);
          setError(null);
        }}
      />
      <div className="history-date-filter__actions">
        <button type="submit">查询</button>
        <button
          type="button"
          onClick={() => {
            setFrom("");
            setTo("");
            setError(null);
            onApply({});
          }}
        >
          重置
        </button>
      </div>
      {error ? (
        <p id={`${id}-error`} role="alert">
          {error}
        </p>
      ) : null}
    </form>
  );
}
