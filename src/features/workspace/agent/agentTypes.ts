import type { NodeModelSelection } from "../workspaceModel";

export interface AgentToolContext {
  readonly signal: AbortSignal;
  readonly callId: string;
  report(message: string): void;
  resolveNodeKey(key: string): string;
  assertCurrent(): void;
  mutate<T>(change: () => T): T;
}

export interface AgentTool {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly effect: "read" | "write" | "render" | "generate" | "download";
  /** 计划确认页的费用提示；缺省按 effect 给默认文案（generate/render/download）。 */
  readonly effectHint?: string;
  validate(args: unknown): void;
  execute(args: unknown, context: AgentToolContext): Promise<unknown>;
}

export interface AgentAction {
  readonly id: string;
  readonly tool: string;
  readonly args: Record<string, unknown>;
  readonly dependsOn: readonly string[];
}

export interface AgentMessage {
  readonly id: string;
  readonly role: "user" | "assistant" | "tool";
  readonly content: string;
}

export interface AgentPlan {
  readonly id: string;
  readonly message: string;
  readonly actions: readonly AgentAction[];
  readonly signature: string;
  readonly review?: readonly string[];
}

/** 归档的历史聊天；标题取自首条用户消息，随画布文档持久化。 */
export interface AgentChatSession {
  readonly id: string;
  readonly title: string;
  readonly messages: readonly AgentMessage[];
}

export interface AgentState {
  readonly version: 2;
  readonly expanded: boolean;
  readonly model: NodeModelSelection | null;
  /** 当前聊天；历史聊天存放在 sessions 中。 */
  readonly messages: readonly AgentMessage[];
  /** 归档聊天，最新在前。 */
  readonly sessions: readonly AgentChatSession[];
  /** 当前聊天来自的历史会话 id；新开的聊天为 null。 */
  readonly activeSessionId: string | null;
  readonly pending: AgentPlan | null;
  readonly status: "idle" | "thinking" | "executing";
  readonly progress: string;
  readonly error: string | null;
}
