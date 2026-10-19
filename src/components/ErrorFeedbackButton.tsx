import { useEffect } from "react";
import {
  captureApplicationError,
  errorDiagnostic,
  openFeedback,
  feedbackOccurrence,
} from "../lib/errorReporting";
import { Icon } from "./Icon";

export function ErrorFeedbackButton({ error }: { readonly error: unknown }) {
  useEffect(() => {
    captureApplicationError(error, "ui");
  }, [error]);
  return (
    <button
      type="button"
      className="error-copy-button"
      title="向开发者反馈这个问题"
      onMouseDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        const occurrence = feedbackOccurrence(error);
        openFeedback(errorDiagnostic(error, occurrence.operation), occurrence);
      }}
    >
      <Icon name="paper-plane-right" aria-hidden="true" size="xs" />
      反馈问题
    </button>
  );
}
