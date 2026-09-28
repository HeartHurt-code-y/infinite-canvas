import * as v from "valibot";
import { topologicallySortWorkflowSteps } from "../workflowExecutionPlan";
import { stableJsonSignature } from "../../../lib/workflowSignatures";
import type { NodeModelSelection } from "../workspaceModel";
import type { WhiteModelScenePlan } from "../../../lib/whiteModelScene";
import type {
  AgentAction,
  AgentMessage,
  AgentState,
  AgentTool,
  AgentToolContext,
} from "./agentTypes";

const actionSchema = v.strictObject({
  id: v.pipe(v.string(), v.minLength(1), v.maxLength(80)),
  tool: v.pipe(v.string(), v.minLength(1)),
  args: v.record(v.string(), v.unknown()),
  dependsOn: v.array(v.string()),
});
const replySchema = v.strictObject({
  message: v.pipe(v.string(), v.maxLength(30_000)),
  actions: v.pipe(v.array(actionSchema), v.maxLength(16)),
});
const messageSchema = v.strictObject({
  id: v.string(),
  role: v.picklist(["user", "assistant", "tool"]),
  content: v.string(),
});

export interface CanvasAgentHost {
  tools: readonly AgentTool[];
  /** Includes current prompts, models, edges and media identities, never chat UI state. */
  signature(): string;
  context(): unknown;
  available(): boolean;
  save(): Promise<void>;
  ask(model: NodeModelSelection, prompt: string): Promise<string>;
  review?(actions: readonly AgentAction[]): readonly string[];
  previewScenes?(actions: readonly AgentAction[]): ReadonlyMap<string, WhiteModelScenePlan>;
}

const initialState = (): AgentState => ({
  version: 1,
  expanded: false,
  model: null,
  messages: [],
  pending: null,
  status: "idle",
  progress: "",
  error: null,
});
const failureText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** One runtime per canvas; model output is data and never an execution authority. */
export class CanvasAgentController {
  private state = initialState();
  private listeners = new Set<() => void>();
  private host: CanvasAgentHost | null = null;
  private abort: AbortController | null = null;
  private expected = "";
  private aliases = new Map<string, string>();
  private executed = new Set<string>();
  getState = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  configure(host: CanvasAgentHost) {
    this.host = host;
  }
  getTools = (): readonly AgentTool[] => this.host?.tools ?? [];
  getScenePreviews = (
    actions: readonly AgentAction[],
  ): ReadonlyMap<string, WhiteModelScenePlan> => {
    try {
      return this.host?.previewScenes?.(actions) ?? new Map();
    } catch {
      return new Map();
    } // A changed/deleted scene invalidates approval; never crash the panel.
  };
  private update(patch: Partial<AgentState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((listener) => listener());
  }
  private append(role: AgentMessage["role"], content: string) {
    this.update({ messages: [...this.state.messages, { id: crypto.randomUUID(), role, content }] });
  }
  private async save() {
    await this.host?.save();
  }
  private saveUI() {
    void this.save().catch((error: unknown) =>
      this.update({ error: `对话保存失败：${failureText(error)}` }),
    );
  }
  setExpanded = (expanded: boolean) => {
    this.update({ expanded });
    this.saveUI();
  };
  setModel = (model: NodeModelSelection | null) => {
    if (this.state.status !== "idle") return;
    this.update({ model, pending: null });
    this.saveUI();
  };
  restore(raw: unknown) {
    if (!raw || typeof raw !== "object") return;
    const schema = v.object({
      version: v.literal(1),
      expanded: v.boolean(),
      model: v.nullable(v.object({ providerId: v.string(), modelDefinitionId: v.string() })),
      messages: v.array(messageSchema),
      status: v.string(),
    });
    const parsed = v.safeParse(schema, raw);
    if (!parsed.success) throw new Error("创作助手对话存档损坏，请保留存档后重试。");
    const data = parsed.output;
    this.state = {
      ...initialState(),
      expanded: data.expanded,
      model: data.model,
      messages: data.messages,
    };
    if (data.status !== "idle" || ("pending" in raw && raw.pending)) {
      this.append(
        "assistant",
        "上次制作已中断，旧计划的确认已失效。已保存的节点和白模渲染任务仍保留；请说明要继续的内容，我会读取当前状态重新规划。",
      );
    } else this.update({});
  }
  reject = () => {
    this.update({ pending: null, progress: "已撤回计划，可以继续描述修改要求。" });
    this.saveUI();
  };
  stop = () => {
    this.abort?.abort();
    this.update({
      pending: null,
      progress: this.abort
        ? "正在停止后续操作；已提交的模型请求可能仍在处理。"
        : "已停止后续操作。",
    });
    this.saveUI();
  };
  private requireHost() {
    if (!this.host || !this.host.available())
      throw new Error("请在已加载的当前画布中使用创作助手。");
    return this.host;
  }
  private assertCurrent = () => {
    if (this.abort?.signal.aborted) throw new Error("已停止后续操作。");
    const host = this.requireHost();
    if (host.signature() !== this.expected)
      throw new Error("画布内容已改变，原计划已失效。请重新描述需求并确认新计划。");
  };
  /** All synchronous canvas writes cross the same revision check. */
  mutate = <T>(change: () => T): T => {
    this.assertCurrent();
    const result = change();
    this.expected = this.requireHost().signature();
    return result;
  };
  private validate<T extends AgentAction>(actions: readonly T[]) {
    const host = this.requireHost();
    const sorted = topologicallySortWorkflowSteps(actions);
    const generating = sorted.filter(
      (action) => host.tools.find((tool) => tool.name === action.tool)?.effect === "generate",
    );
    if (generating.length > 1 || (generating.length && sorted.at(-1) !== generating[0]))
      throw new Error("首版一次计划仅支持最后一步提交一个生成节点，完成后再规划下游制作。");
    for (const action of sorted) {
      const tool = host.tools.find((item) => item.name === action.tool);
      if (!tool) throw new Error(`助手请求了未注册的能力：${action.tool}`);
      tool.validate(action.args);
      const ancestors = new Set<string>();
      const visit = (id: string) => {
        if (ancestors.has(id)) return;
        ancestors.add(id);
        sorted.find((item) => item.id === id)!.dependsOn.forEach(visit);
      };
      action.dependsOn.forEach(visit);
      for (const field of ["nodeKey", "fromKey", "toKey"]) {
        const reference = action.args[field];
        if (
          typeof reference === "string" &&
          reference.startsWith("$") &&
          !ancestors.has(reference.slice(1))
        )
          throw new Error(`节点引用 ${reference} 必须指向已声明的前序依赖。`);
      }
    }
    return sorted;
  }
  private async execute(actions: readonly AgentAction[], approved: boolean) {
    const host = this.requireHost();
    const sorted = this.validate(actions);
    if (
      !approved &&
      sorted.some(
        (action) => host.tools.find((tool) => tool.name === action.tool)!.effect !== "read",
      )
    )
      throw new Error("制作计划尚未确认。");
    for (const action of sorted) {
      this.assertCurrent();
      const tool = host.tools.find((item) => item.name === action.tool)!;
      // A repeated click cannot replay a completed call in this run.
      if (this.executed.has(action.id)) throw new Error("工具调用身份重复，请重新规划。");
      this.update({ status: "executing", progress: tool.title });
      await this.save();
      this.assertCurrent();
      const context: AgentToolContext = {
        signal: this.abort!.signal,
        callId: action.id,
        report: (progress) => this.update({ progress }),
        resolveNodeKey: (key) => {
          if (!key.startsWith("$")) return key;
          const value = this.aliases.get(key.slice(1));
          if (!value) throw new Error(`找不到前序步骤创建的节点：${key}`);
          return value;
        },
        assertCurrent: this.assertCurrent,
        mutate: this.mutate,
      };
      const result = await tool.execute(action.args, context);
      this.executed.add(action.id);
      if (
        result &&
        typeof result === "object" &&
        "nodeKey" in result &&
        typeof result.nodeKey === "string"
      )
        this.aliases.set(action.id, result.nodeKey);
      this.append("tool", `${tool.title}：${JSON.stringify(result)}`);
      await this.save();
      this.assertCurrent();
    }
  }
  private async reason() {
    const host = this.requireHost();
    const model = this.state.model;
    if (!model?.providerId || !model.modelDefinitionId)
      throw new Error("请先选择创作助手使用的文本模型。");
    // Bound tool chatter and malformed JSON repair, independently of model instructions.
    for (let round = 0; round < 6; round++) {
      this.assertCurrent();
      this.update({ status: "thinking", progress: "正在理解需求与画布…" });
      await this.save();
      this.assertCurrent();
      const prompt = JSON.stringify({
        tools: host.tools.map(({ name, title, description, inputSchema, effect }) => ({
          name,
          title,
          description,
          inputSchema,
          effect,
        })),
        context: host.context(),
        conversation: this.state.messages,
        instructions:
          "只使用注册工具。新节点在后续步骤用 $步骤id 引用，必须声明 dependsOn。白模先创建视频节点，再 set_scene，render 会导出并放回画布。所有写入都需要批准，请返回完整可审阅计划；不要声称计划已执行。已有信息优先读取。只能从实际工具结果判断成功。",
      });
      let raw: string;
      try {
        raw = await host.ask(model, prompt);
      } catch (error) {
        this.assertCurrent();
        throw error;
      }
      this.assertCurrent();
      let reply: v.InferOutput<typeof replySchema>;
      try {
        reply = v.parse(
          replySchema,
          JSON.parse(
            raw
              .trim()
              .replace(/^```(?:json)?\s*/i, "")
              .replace(/\s*```$/, ""),
          ),
        );
        reply = { ...reply, actions: this.validate(reply.actions) };
      } catch (error) {
        if (round >= 1)
          throw new Error(`助手计划无法执行：${failureText(error)}`, { cause: error });
        this.append(
          "tool",
          `计划未执行，结构校验失败：${failureText(error)}。请根据已注册工具修正。`,
        );
        continue;
      }
      this.append("assistant", reply.message);
      if (!reply.actions.length) return;
      if (
        reply.actions.some(
          (action) => host.tools.find((tool) => tool.name === action.tool)!.effect !== "read",
        )
      ) {
        // Derive and validate local motion edits before asking for approval. These previews are
        // deliberately not persisted in chat state or sent back to the model.
        host.previewScenes?.(reply.actions);
        this.update({
          pending: {
            id: crypto.randomUUID(),
            message: reply.message,
            actions: reply.actions,
            review: host.review?.(reply.actions) ?? [],
            signature: stableJsonSignature({
              canvas: this.expected,
              model,
              actions: reply.actions,
            }),
          },
        });
        return;
      }
      this.executed.clear();
      this.aliases.clear();
      await this.execute(reply.actions, false);
    }
    throw new Error("已达到本轮自动查询次数上限，已停止。请补充目标或缩小范围。");
  }
  private async run(work: () => Promise<void>) {
    if (this.state.status !== "idle") return;
    this.abort = new AbortController();
    this.aliases.clear();
    this.executed.clear();
    this.update({ status: "thinking", error: null });
    try {
      await work();
    } catch (error) {
      this.update({ error: failureText(error), pending: null });
      this.append(
        "tool",
        `本轮未全部完成：${failureText(error)}。已成功的步骤见执行记录；未确认结果的任务不能自动重试。`,
      );
    } finally {
      this.abort = null;
      this.update({ status: "idle", progress: "" });
      try {
        await this.save();
      } catch (error) {
        this.update({ error: `对话保存失败：${failureText(error)}` });
      }
    }
  }
  send = async (text: string) => {
    if (!text.trim() || this.state.status !== "idle") return;
    await this.run(async () => {
      const host = this.requireHost();
      this.expected = host.signature();
      this.update({ pending: null });
      this.append("user", text.trim());
      await this.reason();
    });
  };
  approve = async () => {
    const plan = this.state.pending;
    if (!plan || this.state.status !== "idle") return;
    await this.run(async () => {
      const host = this.requireHost();
      this.expected = host.signature();
      const signature = stableJsonSignature({
        canvas: this.expected,
        model: this.state.model,
        actions: plan.actions,
      });
      if (signature !== plan.signature)
        throw new Error("画布、模型或计划已改变，确认已失效。请重新规划。");
      this.update({ pending: null });
      this.append("user", "确认执行上面的制作计划。");
      this.append("tool", `已确认的制作计划：${JSON.stringify(plan.actions)}`);
      await this.execute(plan.actions, true);
      this.append(
        "assistant",
        "本次确认的步骤已完成。可以继续描述修改要求；已提交的生成任务可在画布和历史中查看。",
      );
    });
  };
}
