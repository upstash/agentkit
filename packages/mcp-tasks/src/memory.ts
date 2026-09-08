/**
 * Single-process backends, for tests and for a first local run before you have QStash creds.
 *
 * They are honest about what they are: {@link MemoryTaskStore} loses everything on restart, and
 * {@link InlineTaskDispatcher} runs the work in the process that accepted the tool call — the
 * exact fire-and-forget shape that leaves a durable record of a task stuck in `working` when the
 * process dies. Use them to develop against; use the Upstash backends to survive a deploy.
 */
import {
  isTerminal,
  UnknownTaskError,
  type Task,
  type TaskDispatcher,
  type TaskEndpoints,
  type TaskPatch,
  type TaskStore,
  type TerminalTaskPatch,
} from "./types.js";

/** An in-process {@link TaskStore}. Not durable, not shared between instances. */
export class MemoryTaskStore implements TaskStore {
  private readonly tasks = new Map<string, Task>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  async create(task: Task): Promise<void> {
    this.tasks.set(task.taskId, { ...task });
    if (task.ttlMs !== null && task.ttlMs > 0) {
      // Stands in for Redis EXPIRE. Unref'd so a pending TTL never holds the process open.
      const timer = setTimeout(() => {
        this.tasks.delete(task.taskId);
        this.timers.delete(task.taskId);
      }, task.ttlMs);
      timer.unref?.();
      this.timers.set(task.taskId, timer);
    }
  }

  async get(taskId: string): Promise<Task | null> {
    const task = this.tasks.get(taskId);
    return task ? { ...task } : null;
  }

  async update(taskId: string, patch: TaskPatch): Promise<Task> {
    const task = this.tasks.get(taskId);
    if (!task) throw new UnknownTaskError(taskId);
    const next: Task = { ...task, ...patch, lastUpdatedAt: new Date().toISOString() };
    this.tasks.set(taskId, next);
    return { ...next };
  }

  async settle(taskId: string, patch: TerminalTaskPatch): Promise<Task | null> {
    const task = this.tasks.get(taskId);
    // A single-threaded runtime gives this the atomicity the Lua script buys on Redis: nothing
    // can interleave between the read and the write below.
    if (!task || isTerminal(task.status)) return null;
    const next: Task = { ...task, ...patch, lastUpdatedAt: new Date().toISOString() };
    this.tasks.set(taskId, next);
    return { ...next };
  }

  /** Drops every task and its pending expiry. Handy between tests. */
  clear(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.tasks.clear();
  }
}

/**
 * Runs a task in the current process, on the next tick.
 *
 * There is nothing durable about it, and nothing to cancel once the work has started — `cancel`
 * is a no-op, so stopping relies entirely on the handler checking `isCancelled()`.
 */
export class InlineTaskDispatcher implements TaskDispatcher {
  private readonly pending = new Set<Promise<void>>();
  private endpoints: TaskEndpoints | undefined;
  private readonly autoRun: boolean;

  /** How many tasks have been dispatched. Test-only. */
  dispatched = 0;

  constructor(config: { autoRun?: boolean } = {}) {
    // `autoRun: false` records dispatches without running them, so a test can drive execution
    // itself and observe what a single attempt does.
    this.autoRun = config.autoRun ?? true;
  }

  attach(endpoints: TaskEndpoints): void {
    this.endpoints = endpoints;
  }

  async dispatch(taskId: string): Promise<string | undefined> {
    this.dispatched += 1;
    if (!this.autoRun) return undefined;
    const endpoints = this.endpoints;
    if (!endpoints) {
      throw new Error(
        "This dispatcher is not attached to a task layer — pass it to createTaskLayer().",
      );
    }

    // Deferred to a microtask so the tool call returns its handle before the work starts, which
    // is the ordering a real queue gives you for free.
    const run = Promise.resolve()
      .then(() => endpoints.run(taskId))
      .then(
        () => undefined,
        // There are no retries in this process, so the first error is the last one.
        (cause: unknown) =>
          endpoints
            .fail(taskId, {
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

  async cancel(): Promise<void> {
    // Nothing to un-enqueue: the work is already running in this process.
  }

  /** Resolves once every dispatched task has settled. Test-only. */
  async drain(): Promise<void> {
    while (this.pending.size > 0) await Promise.all([...this.pending]);
  }
}
