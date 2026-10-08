/** The Upstash task backends: the record in Redis, the work delivered by QStash. */
import type { Redis } from "@upstash/redis";
import type { Client as QStashClient, Receiver } from "@upstash/qstash";
import {
  INTERNAL_ERROR,
  lazy,
  nonRetryable,
  readQStashJson,
  resolveQStash,
  resolveReceiver,
  resolveRedis,
} from "../../shared/clients.js";
import { fromBase64, fromUtf8 } from "../../shared/crypto.js";
import type {
  Task,
  TaskDispatcher,
  TaskEndpoints,
  TaskError,
  TaskPatch,
  TaskStore,
  TerminalTaskStatus,
} from "../types.js";

/**
 * Backoff between deliveries: 1s, 3s, 9s, 27s, 81s. About two minutes over the default retries,
 * long enough to outlast a deploy or a crash loop.
 */
const DEFAULT_RETRY_DELAY = "min(pow(3, retried) * 1000, 300000)";

/** Delivery retries. 5 is the most QStash's free tier and local dev server accept. */
const DEFAULT_RETRIES = 5;

export type RedisTaskStoreConfig = {
  /**
   * The Upstash Redis client. Defaults to one from `UPSTASH_REDIS_REST_URL` / `_TOKEN`. A client
   * built with `automaticDeserialization: false` is not supported.
   */
  redis?: Redis;
  /** Key prefix. Defaults to `mcp:task:`. */
  prefix?: string;
  /** Set `false` to skip this package's tag in the telemetry header. */
  enableTelemetry?: boolean;
};

/**
 * Applies fields only while the task is non-terminal, and returns `HGETALL` after the call, or nil
 * when the task is missing. Values are JSON-encoded, hence the quoted statuses.
 */
const GUARDED_WRITE_SCRIPT = `#!lua flags=allow-key-locking
local status = redis.call('HGET', KEYS[1], 'status')
if not status then return false end
if status ~= '"completed"' and status ~= '"failed"' and status ~= '"cancelled"' then
  redis.call('HSET', KEYS[1], unpack(ARGV))
end
return redis.call('HGETALL', KEYS[1])
`;

/**
 * One Redis hash per task, so concurrent writers only touch their own fields. The TTL is set at
 * creation and never extended.
 */
export class RedisTaskStore implements TaskStore {
  private readonly prefix: string;
  private readonly redis: () => Redis;

  constructor(config: RedisTaskStoreConfig = {}) {
    this.prefix = config.prefix ?? "mcp:task:";
    this.redis = lazy(() => resolveRedis("RedisTaskStore", config.redis, config.enableTelemetry));
  }

  async create(task: Task): Promise<void> {
    const key = this.key(task.taskId);
    await this.redis().multi().hset(key, toFields(task)).pexpire(key, task.ttlMs).exec();
  }

  async get(taskId: string): Promise<Task | null> {
    const fields = await this.redis().hgetall<Record<string, unknown>>(this.key(taskId));
    return fields && Object.keys(fields).length > 0 ? (fields as Task) : null;
  }

  async update(taskId: string, patch: TaskPatch): Promise<void> {
    await this.guardedWrite(taskId, patch);
  }

  async settle(
    taskId: string,
    patch: TaskPatch & { status: TerminalTaskStatus },
  ): Promise<Task | null> {
    return await this.guardedWrite(taskId, patch);
  }

  private key(taskId: string): string {
    return this.prefix + taskId;
  }

  private async guardedWrite(taskId: string, patch: TaskPatch): Promise<Task | null> {
    const fields = toFields({ ...patch, lastUpdatedAt: new Date().toISOString() });
    const reply = await this.redis().eval<string[], unknown[] | null>(
      GUARDED_WRITE_SCRIPT,
      [this.key(taskId)],
      Object.entries(fields).flat(),
    );
    if (!Array.isArray(reply) || reply.length === 0) return null;
    const task: Record<string, unknown> = {};
    for (let i = 0; i + 1 < reply.length; i += 2) task[String(reply[i])] = reply[i + 1];
    return task as Task;
  }
}

export type QStashDispatcherConfig = {
  /** The public URL QStash delivers to: the route serving `tasks.createExecuteHandler()`. */
  url: string;
  /** The QStash client. Defaults to one from `QSTASH_TOKEN` (and `QSTASH_URL`). */
  qstash?: QStashClient;
  /**
   * Verifies deliveries. Defaults to one from `QSTASH_CURRENT_SIGNING_KEY` /
   * `QSTASH_NEXT_SIGNING_KEY`. Required either way: without keys the endpoint refuses to serve.
   */
  receiver?: Receiver;
  /** Delivery retries before QStash dead-letters a task. Defaults to 5. */
  retries?: number;
  /**
   * Backoff as a QStash delay expression. Defaults to about two minutes over five retries. Size
   * the total budget against your deploys: it has to outlast a restart.
   */
  retryDelay?: string;
  /** Set `false` to skip this package's tag in the telemetry header. */
  enableTelemetry?: boolean;
};

/**
 * Publishes each task to QStash, which stores it durably and retries a failing endpoint. The whole
 * handler runs in one invocation, so it is bound by your function's time limit; use
 * `WorkflowDispatcher` for longer work.
 */
export class QStashDispatcher implements TaskDispatcher {
  private readonly config: QStashDispatcherConfig;
  private readonly qstash: () => QStashClient;
  private readonly receiver: () => Receiver;

  constructor(config: QStashDispatcherConfig) {
    this.config = config;
    this.qstash = lazy(() =>
      resolveQStash("QStashDispatcher", config.qstash, config.enableTelemetry),
    );
    this.receiver = lazy(() => resolveReceiver("QStashDispatcher", config.receiver));
  }

  async dispatch(task: Task): Promise<void> {
    await this.qstash().publishJSON({
      url: this.config.url,
      body: { taskId: task.taskId },
      retries: this.config.retries ?? DEFAULT_RETRIES,
      retryDelay: this.config.retryDelay ?? DEFAULT_RETRY_DELAY,
      // Comes back to the same route once retries are exhausted, and settles the task `failed`.
      failureCallback: this.config.url,
    });
  }

  /** Nothing to stop: a redelivery of a cancelled task finds it settled and does nothing. */
  async cancel(): Promise<void> {}

  /**
   * The delivery endpoint. A delivery (`{ taskId }`) runs the task; a failure callback
   * (`sourceBody`) settles it `failed`.
   *
   * - **200**: done.
   * - **500**: the handler threw; QStash delivers again.
   * - **489** with `Upstash-NonRetryable-Error`: bad signature or body. QStash retries every other
   *   non-2xx, so this is the only way to stop it.
   */
  createExecuteHandler(endpoints: TaskEndpoints): (request: Request) => Promise<Response> {
    return async (request: Request): Promise<Response> => {
      // Outside any try: missing signing keys are a configuration error, not a bad signature.
      const payload = await readQStashJson(request, this.receiver(), this.config.url);
      if (payload instanceof Response) return payload;
      const body = (payload ?? {}) as DeliveryBody;

      const failure = readFailureCallback(body);
      if (failure) {
        await endpoints.fail(failure.taskId, failure.error);
        return new Response("recorded");
      }
      if (typeof body.taskId !== "string") return nonRetryable("missing taskId");

      try {
        await endpoints.run(body.taskId, undefined);
        return new Response("ok");
      } catch (error) {
        console.error(`[mcp-toolkit] task ${body.taskId} failed, asking QStash to retry:`, error);
        return new Response("retry", { status: 500 });
      }
    };
  }
}

/** Either body QStash posts to the execute endpoint. */
type DeliveryBody = {
  /** A delivery: the body we published. */
  taskId?: string;
  /** A failure callback: base64 of the failed message's body. */
  sourceBody?: string;
  /** The last response's status. */
  status?: number;
  /** Base64 of the last response's body. */
  body?: string;
  dlqId?: string;
  retried?: number;
  maxRetries?: number;
};

function readFailureCallback(
  payload: DeliveryBody,
): { taskId: string; error: TaskError } | undefined {
  if (typeof payload.sourceBody !== "string") return undefined;
  let taskId: unknown;
  try {
    taskId = (JSON.parse(fromUtf8(fromBase64(payload.sourceBody))) as { taskId?: unknown }).taskId;
  } catch {
    return undefined;
  }
  if (typeof taskId !== "string") return undefined;
  const response =
    typeof payload.body === "string" ? fromUtf8(fromBase64(payload.body)) : undefined;
  return {
    taskId,
    error: {
      code: INTERNAL_ERROR,
      message: `Delivery failed after ${payload.retried ?? payload.maxRetries ?? "all"} retries${
        payload.status ? ` (last status ${payload.status})` : ""
      }`,
      data: { dlqId: payload.dlqId, status: payload.status, response },
    },
  };
}

/**
 * Hash fields for `HSET`. Every value is JSON-encoded, so the client's automatic deserialization
 * on read is its exact inverse (`"123"` stays a string).
 */
function toFields(patch: Partial<Task>): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const [field, value] of Object.entries(patch)) {
    if (value !== undefined) fields[field] = JSON.stringify(value);
  }
  return fields;
}
