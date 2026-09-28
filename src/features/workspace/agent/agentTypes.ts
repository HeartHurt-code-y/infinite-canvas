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
  readonly effect: "read" | "write" | "render" | "generate";
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

export interface AgentState {
  readonly version: 1;
  readonly expanded: boolean;
  readonly model: NodeModelSelection | null;
  readonly messages: readonly AgentMessage[];
  readonly pending: AgentPlan | null;
  readonly status: "idle" | "thinking" | "executing";
  readonly progress: string;
  readonly error: string | null;
}
