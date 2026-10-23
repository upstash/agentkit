/**
 * The in-memory backends: what `McpTasks` uses when it is given no `store` and no
 * `dispatcher`. Tasks live in this process's memory and run in this process, so the setup needs no
 * Redis, no QStash and no execute endpoint.
 *
 * They do not survive a restart, and they are not shared: on serverless (where every request may
 * land on a different instance, and work after the response may be frozen) or behind several
 * instances, a `tasks/get` can reach an instance that never saw the task. Use `RedisTaskStore` with
 * `QStashDispatcher` or `WorkflowDispatcher` from `@upstash/mcp-toolkit/upstash` there.
 */
import { INTERNAL_ERROR } from "../shared/env.js";
import type {
  Task,
  TaskDispatcher,
  TaskEndpoints,
  TaskInputContext,
  TaskInputResponse,
  TaskInputWait,
  TaskPatch,
  TaskStore,
  TerminalTaskStatus,
} from "./types.js";

/** The statuses no write may leave. */
export const isTerminal = (status: string | undefined): boolean =>
  status === "completed" || status === "failed" || status === "cancelled";

/** How often, at most, `create` sweeps out expired records. */
const SWEEP_INTERVAL_MS = 60_000;

/**
 * A {@link TaskStore} in this process's memory. Records expire `ttlMs` after creation, as in
 * Redis, and the first terminal write wins. Lost on restart, and not shared between instances.
 */
export class MemoryTaskStore implements TaskStore {
  private readonly tasks = new Map<string, { task: Task; expiresAt: number }>();
  private lastSweep = Date.now();

  async create(task: Task): Promise<void> {
    const now = Date.now();
    // Expiry is checked on read; the sweep only frees memory. No timers, so nothing holds the
    // process open and nothing depends on a runtime's timer limits.
    if (now - this.lastSweep >= SWEEP_INTERVAL_MS) {
      this.lastSweep = now;
      for (const [taskId, entry] of this.tasks) {
        if (entry.expiresAt <= now) this.tasks.delete(taskId);
      }
    }
    this.tasks.set(task.taskId, { task: { ...task }, expiresAt: now + task.ttlMs });
  }

  async get(taskId: string): Promise<Task | null> {
    const task = this.live(taskId)?.task;
    return task ? { ...task } : null;
  }

  async update(taskId: string, patch: TaskPatch): Promise<void> {
    this.write(taskId, patch);
  }

  async settle(
    taskId: string,
    patch: TaskPatch & { status: TerminalTaskStatus },
  ): Promise<Task | null> {
    return this.write(taskId, patch);
  }

  async respond(
    taskId: string,
    responses: Record<string, TaskInputResponse>,
    statusMessage: string,
  ): Promise<string[]> {
    // Synchronous from here on, so nothing interleaves between the checks and the write.
    const entry = this.live(taskId);
    const open = entry?.task.status === "input_required" ? entry.task.inputRequests : undefined;
    if (!entry || !open) return [];
    const answers = { ...entry.task.inputResponses };
    for (const [key, response] of Object.entries(responses)) {
      if (key in open && !(key in answers)) answers[key] = response;
    }
    const keys = Object.keys(open);
    const resumed = keys.every((key) => key in answers);
    const { inputRequests: _open, ...rest } = entry.task;
    entry.task = {
      ...(resumed ? { ...rest, status: "working", statusMessage } : entry.task),
      inputResponses: answers,
      lastUpdatedAt: new Date().toISOString(),
    };
    return resumed ? keys : [];
  }

  async countActive(owner: string): Promise<number> {
    const now = Date.now();
    let count = 0;
    for (const { task, expiresAt } of this.tasks.values()) {
      if (task.owner === owner && expiresAt > now && !isTerminal(task.status)) count++;
    }
    return count;
  }

  private live(taskId: string): { task: Task; expiresAt: number } | undefined {
    const entry = this.tasks.get(taskId);
    if (entry && entry.expiresAt <= Date.now()) {
      this.tasks.delete(taskId);
      return undefined;
    }
    return entry;
  }

  /** Synchronous, so nothing interleaves between the check and the write. Keeps the expiry. */
  private write(taskId: string, patch: TaskPatch): Task | null {
    const entry = this.live(taskId);
    if (!entry) return null;
    if (isTerminal(entry.task.status)) return { ...entry.task };
    entry.task = { ...entry.task, ...patch, lastUpdatedAt: new Date().toISOString() };
    return { ...entry.task };
  }
}

/**
 * A {@link TaskDispatcher} that runs each task in this process, right after the tool call answers.
 * It needs no execute endpoint: `McpTasks` connects it itself.
 *
 * There are no retries: a handler that throws fails the task (the error goes to `console.error`
 * and stays in the record's `error.data`, never to the model). Cancelling is cooperative, as with
 * every dispatcher: the handler stops at its next `isCancelled()` check. Work still running when
 * the process exits is lost, and the task stays `working` until its TTL; `drain()` waits for it,
 * e.g. on shutdown.
 *
 * A handler may ask the user with `task.elicit(...)`: it simply waits in this process until
 * `tasks/update` brings the answer, the task is cancelled, or it expires.
 */
export class InProcessDispatcher implements TaskDispatcher<TaskInputContext> {
  private endpoints: TaskEndpoints<TaskInputContext> | undefined;
  private readonly running = new Set<Promise<void>>();
  /** Wake-ups for handlers waiting on an answer, by task id. */
  private readonly waiting = new Map<string, Set<() => void>>();

  /** Called by `McpTasks`. One dispatcher serves one `McpTasks`. */
  connect(endpoints: TaskEndpoints<TaskInputContext>): void {
    if (this.endpoints && this.endpoints !== endpoints) {
      throw new Error(
        "InProcessDispatcher: already connected to an McpTasks; create one per McpTasks",
      );
    }
    this.endpoints = endpoints;
  }

  async dispatch(task: Task): Promise<void> {
    const endpoints = this.endpoints;
    if (!endpoints) throw new Error("InProcessDispatcher: pass it to new McpTasks(...) first");
    // A macrotask, so the tool call's answer goes out before the work starts.
    const run = new Promise<void>((resolve) => setTimeout(resolve, 0))
      .then(() => endpoints.run(task.taskId, undefined))
      .catch(async (error: unknown) => {
        console.error(`[mcp-toolkit] task ${task.taskId} failed:`, error);
        await endpoints
          .fail(task.taskId, {
            code: INTERNAL_ERROR,
            message: "The task handler threw an error",
            data: { error: error instanceof Error ? error.message : String(error) },
          })
          .catch(() => undefined);
      })
      .finally(() => this.running.delete(run));
    this.running.add(run);
  }

  /**
   * Nothing to recall: a task not yet started finds itself cancelled and does nothing. A handler
   * waiting for an answer is woken, finds the task cancelled, and stops.
   */
  async cancel(taskId: string): Promise<void> {
    this.wake(taskId);
  }

  /**
   * Sleeps until `resume` or `cancel` wakes it, or for one poll interval, so an answer recorded
   * by another instance (with a shared store) or an expiry is still seen.
   */
  async waitForInput(wait: TaskInputWait): Promise<void> {
    const ms = Math.max(0, Math.min(wait.pollIntervalMs, wait.expiresAt - Date.now()));
    await new Promise<void>((resolve) => {
      const wakers = this.waiting.get(wait.taskId) ?? new Set<() => void>();
      this.waiting.set(wait.taskId, wakers);
      const done = () => {
        clearTimeout(timer);
        wakers.delete(done);
        if (wakers.size === 0) this.waiting.delete(wait.taskId);
        resolve();
      };
      const timer = setTimeout(done, ms);
      wakers.add(done);
    });
  }

  async resume(taskId: string): Promise<void> {
    this.wake(taskId);
  }

  private wake(taskId: string): void {
    for (const done of [...(this.waiting.get(taskId) ?? [])]) done();
  }

  /** Not needed: tasks run in process. Answers 404, but still connects it. */
  createExecuteHandler(
    endpoints: TaskEndpoints<TaskInputContext>,
  ): (request: Request) => Promise<Response> {
    this.connect(endpoints);
    return async () =>
      new Response("Tasks run in process: this server has no execute endpoint.", { status: 404 });
  }

  /**
   * Resolves once every task dispatched so far has settled, e.g. before a graceful shutdown. A task
   * waiting for the user's answer counts as running until it is answered, cancelled or expired.
   */
  async drain(): Promise<void> {
    while (this.running.size > 0) await Promise.all([...this.running]);
  }
}
