/*
 * 工作流会话注册表。
 *
 * 为什么需要这一层
 * ----------------
 * 「一个工作流节点上正在跑的会话」此前由 WorkspaceApp 里三件互不相干的东西拼成：
 * AbortController 的 Map、活跃历史 run id 的 Set、在途历史动作的 Set。启动守卫、
 * 完成清理、画布清空、卸载中止、删除校验五类语义散落在 30+ 处直接读写这些容器，
 * 「只有会话本人才能注销自己」「取消不注销（由 runner 的 finally 注销）」这类
 * 关键约束只存在于调用方的自觉里。本类把三张表和五类语义收口为一处；
 * React 侧的 runs 进度记录仍由 `useWorkflowSessions` 持有，这里只管会话本身。
 *
 * 纯 TypeScript、零 React 依赖，控制器级单测不需要渲染任何组件。
 */

/** `begin` 成功后返回的会话凭据：持有中止信号，且只有本人能注销自己。 */
export interface WorkflowSessionToken {
  readonly signal: AbortSignal;
  /** 注销本次会话。若该 key 已被更新的会话占据，则不做任何事。 */
  end(): void;
}

export class WorkflowSessionRegistry {
  private readonly sessions = new Map<string, AbortController>();
  private readonly historyRuns = new Set<string>();
  private readonly historyActions = new Set<string>();

  /**
   * 在 key 上开启会话；该 key 已有会话在跑时返回 null（启动守卫）。
   * 调用方必须在结束时调用 `token.end()`（成功、失败、中止三路都要），
   * 否则该 key 将永远无法再次启动。
   */
  begin(key: string): WorkflowSessionToken | null {
    if (this.sessions.has(key)) return null;
    const controller = new AbortController();
    this.sessions.set(key, controller);
    return {
      signal: controller.signal,
      end: () => {
        if (this.sessions.get(key) === controller) this.sessions.delete(key);
      },
    };
  }

  isRunning(key: string): boolean {
    return this.sessions.has(key);
  }

  /** 发出中止信号但不注销；注销仍由会话本人的 `end()` 完成（与旧语义一致）。 */
  abort(key: string): void {
    this.sessions.get(key)?.abort();
  }

  /** 中止全部会话并清空注册表：画布清空与组件卸载使用。 */
  abortAll(): void {
    for (const controller of this.sessions.values()) controller.abort();
    this.sessions.clear();
  }

  get runningCount(): number {
    return this.sessions.size;
  }

  /** 直接丢弃 key 上的会话（节点被删除时使用；中止信号已由 `abort` 发出）。 */
  remove(key: string): void {
    this.sessions.delete(key);
  }

  /** 正在运行会话的 key 快照；撤销/重做以此排除运行中的节点。 */
  runningKeys(): readonly string[] {
    return [...this.sessions.keys()];
  }

  /** 历史档案开始一次执行；该档案已在跑时返回 false。 */
  beginHistoryRun(id: string): boolean {
    if (this.historyRuns.has(id)) return false;
    this.historyRuns.add(id);
    return true;
  }

  endHistoryRun(id: string): void {
    this.historyRuns.delete(id);
  }

  /** 当前活跃历史 run 的 id 快照；React 侧镜像 state 的唯一取数口。 */
  historyRunIds(): readonly string[] {
    return [...this.historyRuns];
  }

  isHistoryRunActive(id: string): boolean {
    return this.historyRuns.has(id);
  }

  get historyRunCount(): number {
    return this.historyRuns.size;
  }

  /** 历史档案动作（恢复/重跑/定位）互斥守卫；同档案已有动作在途时返回 false。 */
  beginHistoryAction(id: string): boolean {
    if (this.historyActions.has(id)) return false;
    this.historyActions.add(id);
    return true;
  }

  endHistoryAction(id: string): void {
    this.historyActions.delete(id);
  }

  isHistoryActionActive(id: string): boolean {
    return this.historyActions.has(id);
  }

  get historyActionCount(): number {
    return this.historyActions.size;
  }
}
