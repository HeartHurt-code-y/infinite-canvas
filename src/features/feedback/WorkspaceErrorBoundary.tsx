import { Component, type ReactNode } from "react";
import { ErrorAlert } from "../../components/ErrorAlert";
import { captureApplicationError } from "../../lib/errorReporting";
import "./FeedbackHub.css";

export class WorkspaceErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  override state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  override componentDidCatch(error: Error) {
    captureApplicationError(error, "react");
  }
  override render() {
    if (!this.state.error) return this.props.children;
    return (
      <main style={{ padding: "var(--space-lg)", maxWidth: 720, margin: "auto" }}>
        <h1>工作区遇到了问题</h1>
        <ErrorAlert
          error={this.state.error}
          hint="可以先反馈问题，再重新载入工作区。软件会读取上次保存的画布。"
        />
        <button
          type="button"
          className="feedback-button feedback-button--primary"
          onClick={() => window.location.reload()}
        >
          重新载入工作区
        </button>
      </main>
    );
  }
}
