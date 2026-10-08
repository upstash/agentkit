/**
 * Single-process backends for tests and a first local run. Nothing here survives a restart, and
 * {@link InlineTaskDispatcher} runs work in the process that took the tool call.
 */
import {
  isTerminal,
  UnknownTaskError,
  type SettleResult,
  type Task,
  type TaskDispatcher,
  type TaskEndpoints,
  type TaskPatch,
  type TaskStore,
  type TerminalTaskPatch,
} from "../types.js";

/** An in-process {@link TaskStore}. Not durable, not shared between instances. */
export class MemoryTaskStore implements TaskStore {
  private readonly tasks = new Map<string, Task>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  async create(task: Task): Promise<Task | null> {
    const existing = this.tasks.get(task.taskId);
    if (existing) return { ...existing };
    this.tasks.set(task.taskId, { ...task });
    if (task.ttlMs !== null && task.ttlMs > 0) {
      // Stands in for Redis' expiry. Unref'd so it never holds the process open.
      const timer = setTimeout(() => {
        this.tasks.delete(task.taskId);
        this.timers.delete(task.taskId);
      }, task.ttlMs);
      timer.unref?.();
      this.timers.set(task.taskId, timer);
    }
    return null;
  }

  async get(taskId: string): Promise<Task | null> {
    const task = this.tasks.get(taskId);
    return task ? { ...task } : null;
  }

  async update(taskId: string, patch: TaskPatch): Promise<Task> {
    const outcome = this.write(taskId, patch);
    if (!outcome) throw new UnknownTaskError(taskId);
    return outcome.task;
  }

  async settle(taskId: string, patch: TerminalTaskPatch): Promise<SettleResult | null> {
    return this.write(taskId, patch);
  }

  /** Drops every task and its pending expiry. */
  clear(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.tasks.clear();
  }

  /** Synchronous, so nothing interleaves between the check and the write. */
  private write(taskId: string, patch: TaskPatch): SettleResult | null {
    const task = this.tasks.get(taskId);
    if (!task) return null;
    if (isTerminal(task.status)) return { task: { ...task }, settled: false };
    const next: Task = { ...task, ...patch, lastUpdatedAt: new Date().toISOString() };
    this.tasks.set(taskId, next);
    return { task: { ...next }, settled: true };
  }
}

/**
 * Runs a task in the current process, on the next microtask. Nothing is durable and `cancel` is a
 * no-op, so stopping relies on the handler checking `isCancelled()`. A throw fails the task: there
 * are no retries.
 */
export class InlineTaskDispatcher implements TaskDispatcher {
  private readonly pending = new Set<Promise<void>>();
  private endpoints: TaskEndpoints | undefined;

  attach(endpoints: TaskEndpoints): void {
    this.endpoints = endpoints;
  }

  async dispatch(task: Task): Promise<string | undefined> {
    const endpoints = this.endpoints;
    if (!endpoints) {
      throw new Error("InlineTaskDispatcher is not attached — pass it to createTaskLayer().");
    }
    const run = Promise.resolve()
      .then(() => endpoints.run(task.taskId, undefined))
      .then(
        () => undefined,
        (cause: unknown) =>
          endpoints
            .fail(task.taskId, {
              code: -32603,
              message: cause instanceof Error ? cause.message : String(cause),
            })
            .then(
              () => undefined,
              () => undefined,
            ),
      );
    this.pending.add(run);
    void run.finally(() => this.pending.delete(run));
    return undefined;
  }

  async cancel(): Promise<void> {}

  /** Resolves once every dispatched task has settled. */
  async drain(): Promise<void> {
    while (this.pending.size > 0) await Promise.all([...this.pending]);
  }
}
