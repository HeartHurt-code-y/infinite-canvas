import { Component, type ReactNode } from "react";
import { ErrorAlert } from "./ErrorAlert";
import { frontendLog } from "../lib/ipc";
import "./WorkspaceErrorBoundary.css";

/*
 * 工作区级错误边界：渲染期崩溃时兜住整棵工作区树，给出可读的报错与恢复入口。
 *
 * 反馈子系统移除后，这里不再向开发者上报任何资料——只把崩溃信息写进本地
 * 日志文件，用户侧仍可用「复制报错」把完整诊断带走。
 */
export class WorkspaceErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  override state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  override componentDidCatch(error: Error) {
    frontendLog("error", `工作区渲染失败：${error.message}`);
  }
  override render() {
    if (!this.state.error) return this.props.children;
    return (
      <main className="workspace-error-boundary">
        <h1>工作区遇到了问题</h1>
        <ErrorAlert
          error={this.state.error}
          hint="复制完整报错发给开发者，然后重新载入工作区。软件会读取上次保存的画布。"
        />
        <button
          type="button"
          className="workspace-error-boundary__action"
          onClick={() => window.location.reload()}
        >
          重新载入工作区
        </button>
      </main>
    );
  }
}
