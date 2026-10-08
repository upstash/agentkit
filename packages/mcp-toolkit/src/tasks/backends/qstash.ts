/** The Upstash task backends: the record in Redis, the work delivered by QStash. */
import type { Redis } from "@upstash/redis";
import type { Client as QStashClient, Receiver } from "@upstash/qstash";
import {
  lazy,
  nonRetryable,
  resolveQStash,
  resolveReceiver,
  resolveRedis,
} from "../../shared/clients.js";
import { fromBase64, fromUtf8 } from "../../shared/crypto.js";
import {
  UnknownTaskError,
  type SettleResult,
  type Task,
  type TaskDispatcher,
  type TaskEndpoints,
  type TaskError,
  type TaskPatch,
  type TaskStore,
  type TerminalTaskPatch,
} from "../types.js";

/** JSON-RPC internal error. */
const INTERNAL_ERROR = -32603;

/** Default key prefix for task hashes: `mcp:task:<taskId>`. */
export const DEFAULT_TASK_PREFIX = "mcp:task:";

/**
 * Backoff between deliveries: 1s, 3s, 9s, 27s, 81s. About two minutes over the default retries,
 * long enough to outlast a deploy or a crash loop.
 */
export const DEFAULT_RETRY_DELAY = "min(pow(3, retried) * 1000, 300000)";

/** Delivery retries. 5 is the most QStash's free tier and local dev server accept. */
export const DEFAULT_RETRIES = 5;

export type RedisTaskStoreConfig = {
  /**
   * The Upstash Redis client. Defaults to one from `UPSTASH_REDIS_REST_URL` / `_TOKEN`. A client
   * built with `automaticDeserialization: false` is not supported.
   */
  redis?: Redis;
  /** Key prefix. Defaults to {@link DEFAULT_TASK_PREFIX}. */
  prefix?: string;
  /** Set `false` to skip this package's tag in the telemetry header. */
  enableTelemetry?: boolean;
};

/** Creates the hash and its TTL unless the key exists, in which case it returns the existing fields. */
const CREATE_SCRIPT = `#!lua flags=allow-key-locking
if redis.call('EXISTS', KEYS[1]) == 1 then return redis.call('HGETALL', KEYS[1]) end
redis.call('HSET', KEYS[1], unpack(ARGV, 2))
local ttl = tonumber(ARGV[1])
if ttl > 0 then redis.call('PEXPIRE', KEYS[1], ttl) end
return false
`;

/**
 * Applies fields only while the task is non-terminal. Returns `[changed, ...fields]`, or nil when
 * the task is missing. Values are JSON-encoded, hence the quoted statuses.
 */
const GUARDED_WRITE_SCRIPT = `#!lua flags=allow-key-locking
local status = redis.call('HGET', KEYS[1], 'status')
if not status then return false end
local changed = 0
if status ~= '"completed"' and status ~= '"failed"' and status ~= '"cancelled"' then
  redis.call('HSET', KEYS[1], unpack(ARGV))
  changed = 1
end
local fields = redis.call('HGETALL', KEYS[1])
table.insert(fields, 1, changed)
return fields
`;

/**
 * One Redis hash per task, so concurrent writers only touch their own fields. The TTL is set at
 * creation and never extended.
 */
export class RedisTaskStore implements TaskStore {
  private readonly prefix: string;
  private readonly redis: () => Redis;

  constructor(config: RedisTaskStoreConfig = {}) {
    this.prefix = config.prefix ?? DEFAULT_TASK_PREFIX;
    this.redis = lazy(() => resolveRedis("RedisTaskStore", config.redis, config.enableTelemetry));
  }

  async create(task: Task): Promise<Task | null> {
    const ttl = task.ttlMs !== null && task.ttlMs > 0 ? task.ttlMs : 0;
    const existing = await this.redis().eval<string[], unknown[] | null>(
      CREATE_SCRIPT,
      [this.key(task.taskId)],
      [String(ttl), ...toArgs(task)],
    );
    return toTask(existing);
  }

  async get(taskId: string): Promise<Task | null> {
    const fields = await this.redis().hgetall<Record<string, unknown>>(this.key(taskId));
    return fields && Object.keys(fields).length > 0 ? fromFields(fields) : null;
  }

  async update(taskId: string, patch: TaskPatch): Promise<Task> {
    const outcome = await this.guardedWrite(taskId, patch);
    if (!outcome) throw new UnknownTaskError(taskId);
    return outcome.task;
  }

  async settle(taskId: string, patch: TerminalTaskPatch): Promise<SettleResult | null> {
    return await this.guardedWrite(taskId, patch);
  }

  /** The Redis key a task is stored under. */
  key(taskId: string): string {
    return this.prefix + taskId;
  }

  private async guardedWrite(taskId: string, patch: TaskPatch): Promise<SettleResult | null> {
    const reply = await this.redis().eval<string[], unknown[] | null>(
      GUARDED_WRITE_SCRIPT,
      [this.key(taskId)],
      toArgs({ ...patch, lastUpdatedAt: new Date().toISOString() }),
    );
    if (!Array.isArray(reply)) return null;
    const [changed, ...fields] = reply;
    const task = toTask(fields);
    return task ? { task, settled: Number(changed) === 1 } : null;
  }
}

export type QStashDispatcherConfig = {
  /** The public URL QStash delivers to: the route serving `tasks.createExecuteHandler()`. */
  url: string;
  /** The QStash client. Defaults to one from `QSTASH_TOKEN` (and `QSTASH_URL`). */
  qstash?: QStashClient;
  /** Delivery retries before QStash dead-letters a task. Defaults to {@link DEFAULT_RETRIES}. */
  retries?: number;
  /**
   * Backoff as a QStash delay expression. Defaults to {@link DEFAULT_RETRY_DELAY}. Size the total
   * budget against your deploys: it has to outlast a restart.
   */
  retryDelay?: string;
  /** Extra headers to send with each delivery. */
  headers?: Record<string, string>;
  /**
   * Verifies deliveries. Defaults to one from `QSTASH_CURRENT_SIGNING_KEY` /
   * `QSTASH_NEXT_SIGNING_KEY`. Required either way: without keys the endpoint refuses to serve.
   */
  receiver?: Receiver;
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
  private endpoints: TaskEndpoints | undefined;

  constructor(config: QStashDispatcherConfig) {
    this.config = config;
    this.qstash = lazy(() =>
      resolveQStash("QStashDispatcher", config.qstash, config.enableTelemetry),
    );
    this.receiver = lazy(() => resolveReceiver("QStashDispatcher", config.receiver));
  }

  attach(endpoints: TaskEndpoints): void {
    this.endpoints = endpoints;
  }

  async dispatch(task: Task): Promise<string | undefined> {
    const message = await this.qstash().publishJSON({
      url: this.config.url,
      body: { taskId: task.taskId },
      retries: this.config.retries ?? DEFAULT_RETRIES,
      retryDelay: this.config.retryDelay ?? DEFAULT_RETRY_DELAY,
      headers: this.config.headers,
      // Comes back to the same route once retries are exhausted, and settles the task `failed`.
      failureCallback: this.config.url,
      deduplicationId: task.taskId,
    });
    return Array.isArray(message) ? message[0]?.messageId : message.messageId;
  }

  async cancel(dispatchId: string): Promise<void> {
    await this.qstash().messages.cancel(dispatchId);
  }

  /**
   * The delivery endpoint. A delivery (`{ taskId }`) runs the task; a failure callback
   * (`sourceBody`) settles it `failed`.
   *
   * - **200**: done.
   * - **500**: the handler threw; QStash delivers again.
   * - **489** with `Upstash-NonRetryable-Error`: bad signature or body. QStash retries every other
   *   non-2xx, so this is the only way to stop it.
   */
  createExecuteHandler(): (request: Request) => Promise<Response> {
    return async (request: Request): Promise<Response> => {
      const endpoints = this.endpoints;
      if (!endpoints) {
        throw new Error("QStashDispatcher is not attached — pass it to createTaskLayer().");
      }
      // Outside the try: missing signing keys are a configuration error, not a bad signature.
      const receiver = this.receiver();
      const body = await request.text();
      try {
        // Against the URL we published to: behind a proxy, `request.url` is the internal one.
        await receiver.verify({
          signature: request.headers.get("upstash-signature") ?? "",
          body,
          url: this.config.url,
        });
      } catch {
        return nonRetryable("invalid signature");
      }

      let payload: DeliveryBody;
      try {
        payload = JSON.parse(body) as DeliveryBody;
      } catch {
        return nonRetryable("malformed body");
      }

      const failure = readFailureCallback(payload);
      if (failure) {
        await endpoints.fail(failure.taskId, failure.error);
        return new Response("recorded");
      }
      if (!payload.taskId) return nonRetryable("missing taskId");

      try {
        await endpoints.run(payload.taskId, undefined);
        return new Response("ok");
      } catch (error) {
        console.error(
          `[mcp-toolkit] task ${payload.taskId} failed, asking QStash to retry:`,
          error,
        );
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
  let taskId: string | undefined;
  try {
    taskId = (JSON.parse(decodeBase64(payload.sourceBody)) as { taskId?: string }).taskId;
  } catch {
    return undefined;
  }
  if (!taskId) return undefined;
  const response = typeof payload.body === "string" ? decodeBase64(payload.body) : undefined;
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

const decodeBase64 = (value: string): string => fromUtf8(fromBase64(value));

/**
 * Hash fields as `HSET` arguments. Every value is JSON-encoded, so the client's automatic
 * deserialization on read is its exact inverse (`"123"` stays a string).
 */
function toArgs(patch: Partial<Task>): string[] {
  const args: string[] = [];
  for (const [field, value] of Object.entries(patch)) {
    if (value !== undefined) args.push(field, JSON.stringify(value ?? null));
  }
  return args;
}

/** A flat field/value list from a script's `HGETALL`, as a task. */
function toTask(reply: unknown[] | null | undefined): Task | null {
  if (!Array.isArray(reply) || reply.length === 0) return null;
  const fields: Record<string, unknown> = {};
  for (let i = 0; i + 1 < reply.length; i += 2) fields[String(reply[i])] = reply[i + 1];
  return fromFields(fields);
}

function fromFields(fields: Record<string, unknown>): Task {
  // `ttlMs: null` means unlimited, so an absent field reads as null too.
  return { ttlMs: null, ...fields } as Task;
}
