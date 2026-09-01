/**
 * The Upstash backends: a {@link TaskStore} on Upstash Redis and a {@link TaskDispatcher} on
 * QStash.
 *
 * Nothing here imports the MCP SDK. That is the point of the two interfaces — a Postgres store or
 * a BullMQ dispatcher drops in without the core noticing.
 */
import { Redis } from "@upstash/redis";
import { Client as QStashClient, Receiver } from "@upstash/qstash";
import {
  TERMINAL_STATUSES,
  UnknownTaskError,
  type Task,
  type TaskDispatcher,
  type TaskPatch,
  type TaskRunner,
  type TaskStore,
  type TerminalTaskPatch,
} from "./types.js";
import { addTelemetry } from "./telemetry.js";

/** Default key prefix for task hashes: `mcp:task:<taskId>`. */
export const DEFAULT_TASK_PREFIX = "mcp:task:";

/**
 * Backoff between delivery attempts: 1s, 3s, 9s, 27s, 81s — about two minutes across the default
 * {@link DEFAULT_RETRIES} attempts, capped so a longer budget cannot drift into hours.
 *
 * The steep base is doing real work. What the retry budget has to outlast is whatever killed the
 * process — a deploy, a crash loop, a cold start. When it does not, the record survives in Redis
 * but nothing ever finishes the job, and the task sits at `working` until its TTL expires: exactly
 * the failure durable execution exists to prevent. A flat one-second delay spends every attempt
 * inside ten seconds, which no restart fits into.
 */
export const DEFAULT_RETRY_DELAY = "min(pow(3, retried) * 1000, 300000)";

/**
 * Delivery attempts before QStash dead-letters a task.
 *
 * **QStash caps this per plan** — the local dev server and the free tier reject anything above 5
 * with `quota maxRetries exceeded`, so 5 is the highest value that works everywhere and the budget
 * is bought with {@link DEFAULT_RETRY_DELAY} instead. Raise it if your plan allows; Vercel's own
 * QStash-backed Workflow world defaults to 47.
 */
export const DEFAULT_RETRIES = 5;

export type RedisTaskStoreConfig = {
  /** The Upstash Redis client. Defaults to `Redis.fromEnv()`. */
  redis?: Redis;
  /** Key prefix for task hashes. Defaults to {@link DEFAULT_TASK_PREFIX}. */
  prefix?: string;
  /** Set `false` to skip reporting the SDK version in the Redis telemetry header. */
  enableTelemetry?: boolean;
};

/**
 * Every field is written JSON-encoded, and read back with no decoding of our own.
 *
 * That pairing is deliberate. `@upstash/redis` deserializes responses by default: it runs one
 * `JSON.parse` over each value and falls back to the raw string. Writing `JSON.stringify(value)`
 * makes that single parse the exact inverse of the write, so a status message of `"123"` returns
 * as the string `"123"` and not the number `123` — which is what an unencoded write, or a second
 * decode of our own, would produce.
 */
const encode = (value: unknown): string => JSON.stringify(value ?? null);

/**
 * The fields whose values are objects. They are the only ones worth repairing if a caller
 * supplied a client built with `automaticDeserialization: false`, since a half-decoded scalar is
 * indistinguishable from a legitimate string.
 */
const OBJECT_FIELDS: ReadonlySet<string> = new Set(["args", "result", "error"]);

/**
 * Moves a task to a terminal state only if it is not terminal already, in one round trip.
 *
 * `ARGV[1]` is how many terminal-status literals follow; the rest are field/value pairs. Returns
 * 1 when this call performed the transition, 0 when the task was missing or already terminal.
 */
const SETTLE_SCRIPT = `
local current = redis.call('HGET', KEYS[1], 'status')
if not current then return 0 end
local terminals = tonumber(ARGV[1])
for i = 2, 1 + terminals do
  if current == ARGV[i] then return 0 end
end
for i = 2 + terminals, #ARGV, 2 do
  redis.call('HSET', KEYS[1], ARGV[i], ARGV[i + 1])
end
return 1
`;

const TERMINAL_LITERALS = [...TERMINAL_STATUSES].map(encode);

/**
 * A task record per Redis hash, with `EXPIRE` doing the TTL cleanup the draft asks for.
 *
 * One field per task property, rather than one JSON blob, so an update is a plain `HSET` of just
 * the fields that changed. Two writers — a progress update and a client's cancel — therefore
 * cannot clobber each other's fields, which a read-modify-write of a single blob would.
 */
export class RedisTaskStore implements TaskStore {
  private readonly prefix: string;
  private readonly enableTelemetry: boolean;
  private readonly resolveRedis: () => Redis;
  private client: Redis | undefined;

  constructor(config: RedisTaskStoreConfig | Redis = {}) {
    // Accept a bare client too, so `new RedisTaskStore(redis)` reads naturally.
    const options: RedisTaskStoreConfig = isRedisClient(config) ? { redis: config } : config;
    this.prefix = options.prefix ?? DEFAULT_TASK_PREFIX;
    this.enableTelemetry = options.enableTelemetry ?? true;
    this.resolveRedis = () => options.redis ?? redisFromEnv();
  }

  /**
   * The client, resolved on first use rather than in the constructor.
   *
   * Constructing must not need credentials: a store is typically created at module scope, and a
   * framework evaluates those modules in places where the environment is not populated — a Next.js
   * production build imports every route module to collect page data, so an eager `fromEnv()` fails
   * the build of an app that would run fine in production.
   */
  private get redis(): Redis {
    if (!this.client) {
      this.client = this.resolveRedis();
      addTelemetry(this.client, { enabled: this.enableTelemetry });
    }
    return this.client;
  }

  async create(task: Task): Promise<void> {
    const key = this.key(task.taskId);
    await this.redis.hset(key, toFields(task));
    // The TTL is set once, at creation. Later updates use HSET, which never touches it, so the
    // retention window is measured from creation no matter how chatty the handler is.
    if (task.ttlMs !== null && task.ttlMs > 0) {
      await this.redis.pexpire(key, task.ttlMs);
    }
  }

  async get(taskId: string): Promise<Task | null> {
    const fields = await this.redis.hgetall<Record<string, unknown>>(this.key(taskId));
    if (!fields || Object.keys(fields).length === 0) return null;
    return fromFields(fields);
  }

  async update(taskId: string, patch: TaskPatch): Promise<Task> {
    const fields = toFields({ ...patch, lastUpdatedAt: new Date().toISOString() });
    // HSET on a missing key would create a partial, TTL-less task, so check first. The check is
    // not a lock: only `settle` needs atomicity, and it has it.
    const exists = await this.redis.exists(this.key(taskId));
    if (!exists) throw new UnknownTaskError(taskId);
    await this.redis.hset(this.key(taskId), fields);
    const task = await this.get(taskId);
    if (!task) throw new UnknownTaskError(taskId);
    return task;
  }

  async settle(taskId: string, patch: TerminalTaskPatch): Promise<Task | null> {
    const fields = toFields({ ...patch, lastUpdatedAt: new Date().toISOString() });
    const args: string[] = [String(TERMINAL_LITERALS.length), ...TERMINAL_LITERALS];
    for (const [field, value] of Object.entries(fields)) args.push(field, value);

    const applied = await this.redis.eval<string[], number>(
      SETTLE_SCRIPT,
      [this.key(taskId)],
      args,
    );
    if (applied !== 1) return null;
    return await this.get(taskId);
  }

  /** The Redis key a task is stored under. */
  key(taskId: string): string {
    return this.prefix + taskId;
  }
}

export type QStashDispatcherConfig = {
  /** The QStash client. Defaults to `new Client({ token: QSTASH_TOKEN, baseUrl: QSTASH_URL })`. */
  qstash?: QStashClient;
  /**
   * The absolute, publicly reachable URL QStash delivers a task to. Your handler there reads
   * `{ taskId }` from the body and calls `executeTask(taskId)`.
   */
  url: string;
  /**
   * Delivery attempts before QStash gives up and dead-letters the message. Defaults to
   * {@link DEFAULT_RETRIES}.
   */
  retries?: number;
  /**
   * Backoff between attempts, as a QStash delay expression. Defaults to exponential —
   * {@link DEFAULT_RETRY_DELAY}.
   *
   * The retry budget is what has to outlast a restart, and it is easy to get wrong: a flat
   * `"1000"` with a handful of retries burns every attempt within seconds, so a process killed
   * mid-task exhausts its redeliveries before it is back up and the task is dead-lettered while
   * still reading `working`. Size the budget against how long your deploys actually take.
   */
  retryDelay?: string;
  /** Extra headers to send with the delivery. */
  headers?: Record<string, string>;
  /**
   * Verifies the signature on incoming deliveries in {@link QStashDispatcher.createExecuteHandler}.
   * Defaults to a `Receiver` built from `QSTASH_CURRENT_SIGNING_KEY` / `QSTASH_NEXT_SIGNING_KEY`.
   */
  receiver?: Receiver;
};

/**
 * Publishes each task to QStash, which stores the message durably before delivery and retries a
 * failing endpoint. That is the half Redis cannot do: if the process that accepted the tool call
 * dies mid-run, the record survives in Redis but only a redelivery finishes the work.
 */
export class QStashDispatcher implements TaskDispatcher {
  private readonly url: string;
  /** How many retries this dispatcher asks QStash for. Pair it with {@link isFinalQStashAttempt}. */
  readonly retries: number;
  private readonly retryDelay: string;
  private readonly headers: Record<string, string> | undefined;
  private readonly resolveQStash: () => QStashClient;
  private client: QStashClient | undefined;
  private readonly resolveReceiver: () => Receiver;
  private verifier: Receiver | undefined;

  constructor(config: QStashDispatcherConfig) {
    this.url = config.url;
    this.retries = config.retries ?? DEFAULT_RETRIES;
    this.retryDelay = config.retryDelay ?? DEFAULT_RETRY_DELAY;
    this.headers = config.headers;
    this.resolveQStash = () => config.qstash ?? qstashFromEnv();
    this.resolveReceiver = () => config.receiver ?? receiverFromEnv();
  }

  /** Resolved on first use, for the same reason as {@link RedisTaskStore}'s client. */
  private get qstash(): QStashClient {
    if (!this.client) this.client = this.resolveQStash();
    return this.client;
  }

  private get receiver(): Receiver {
    if (!this.verifier) this.verifier = this.resolveReceiver();
    return this.verifier;
  }

  async dispatch(taskId: string): Promise<string | undefined> {
    const message = await this.qstash.publishJSON({
      url: this.url,
      body: { taskId },
      retries: this.retries,
      retryDelay: this.retryDelay,
      headers: this.headers,
      // QStash delivery is at-least-once. Pinning deduplication to the task id means a
      // double-submitted tool call cannot enqueue the same task twice.
      deduplicationId: taskId,
    });
    return Array.isArray(message) ? message[0]?.messageId : message.messageId;
  }

  async cancel(dispatchId: string): Promise<void> {
    await this.qstash.messages.cancel(dispatchId);
  }

  /**
   * The delivery endpoint, as a fetch handler: `export const POST = tasks.createExecuteHandler()`.
   *
   * It owns the four things the application would otherwise have to get right by hand — verifying
   * the signature, reading the task id, counting the attempt, and choosing the status code that
   * tells QStash whether to try again.
   *
   * Status codes are the retry contract:
   * - **200** — the task ran, or was already terminal, or was redelivered after finishing. Done.
   * - **401** — the signature did not verify. Deliberately terminal: a retry cannot fix a bad
   *   signature, and answering 500 would make QStash replay an unauthenticated request.
   * - **400** — the body carried no task id. Also terminal, for the same reason.
   * - **500** — the handler threw and QStash still has attempts left. This is the one that asks
   *   for a redelivery.
   */
  createExecuteHandler(run: TaskRunner): (request: Request) => Promise<Response> {
    return async (request: Request): Promise<Response> => {
      const body = await request.text();

      try {
        // Verified against the URL we published to, not `request.url`: behind a proxy the
        // incoming URL is the internal one, while QStash signed the public destination.
        await this.receiver.verify({
          signature: request.headers.get("upstash-signature") ?? "",
          body,
          url: this.url,
        });
      } catch {
        return new Response("invalid signature", { status: 401 });
      }

      let taskId: string | undefined;
      try {
        taskId = (JSON.parse(body) as { taskId?: string }).taskId;
      } catch {
        return new Response("malformed body", { status: 400 });
      }
      if (!taskId) return new Response("missing taskId", { status: 400 });

      try {
        await run(taskId, {
          isFinalAttempt: isFinalQStashAttempt(request.headers, this.retries),
        });
        return new Response("ok");
      } catch {
        // The task's own failure is already recorded by `executeTask`; the non-2xx is purely how
        // you ask QStash for another delivery.
        return new Response("retry", { status: 500 });
      }
    };
  }
}

/** QStash's per-delivery header: how often this message has been retried so far, starting at 0. */
export const QSTASH_RETRIED_HEADER = "upstash-retried";

/**
 * Whether the delivery being handled is QStash's last attempt at this task.
 *
 * Pass the result to `executeTask` as `isFinalAttempt`. It is what keeps a transient failure
 * retryable: before the last attempt the task stays `working` so a retry can still finish it, and
 * only the last one settles it `failed`.
 *
 * @param headers the incoming request's headers
 * @param maxRetries the retry count the dispatcher was configured with (`dispatcher.retries`)
 */
export function isFinalQStashAttempt(
  headers: Headers | Record<string, string | string[] | undefined>,
  maxRetries: number,
): boolean {
  const raw =
    typeof (headers as Headers).get === "function"
      ? (headers as Headers).get(QSTASH_RETRIED_HEADER)
      : firstHeader(headers as Record<string, string | string[] | undefined>);
  // No header means this is not a QStash delivery at all (a manual replay, say). Treating that as
  // the final attempt keeps the safe default: the failure is recorded rather than left hanging.
  // Note `Number(null)` and `Number("")` are both 0, so the emptiness check has to come first.
  if (raw === null || raw === undefined || raw === "") return true;
  const retried = Number(raw);
  if (!Number.isFinite(retried)) return true;
  return retried >= maxRetries;
}

function firstHeader(headers: Record<string, string | string[] | undefined>): string | undefined {
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() !== QSTASH_RETRIED_HEADER) continue;
    return Array.isArray(value) ? value[0] : value;
  }
  return undefined;
}

/** Encodes a partial task into the hash fields that represent it. `undefined` values are skipped. */
function toFields(patch: Partial<Task>): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const [field, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    fields[field] = encode(value);
  }
  return fields;
}

/**
 * Turns stored hash fields back into a task. The client's own deserialization has already undone
 * {@link encode}, so this only skips absent fields and repairs objects that arrived as strings.
 */
function fromFields(fields: Record<string, unknown>): Task {
  const task: Record<string, unknown> = {};
  for (const [field, raw] of Object.entries(fields)) {
    if (raw === undefined) continue;
    if (typeof raw === "string" && OBJECT_FIELDS.has(field)) {
      try {
        task[field] = JSON.parse(raw);
        continue;
      } catch {
        // Not JSON after all — fall through and keep the raw value.
      }
    }
    // `ttlMs: null` is meaningful ("unlimited"), so nulls are kept rather than dropped.
    task[field] = raw;
  }
  if (!("ttlMs" in task)) task.ttlMs = null;
  return task as Task;
}

function isRedisClient(value: RedisTaskStoreConfig | Redis): value is Redis {
  return typeof (value as Redis).hgetall === "function";
}

function redisFromEnv(): Redis {
  const { UPSTASH_REDIS_REST_URL: url, UPSTASH_REDIS_REST_TOKEN: token } = process.env;
  if (!url || !token) {
    throw new Error(
      "RedisTaskStore needs a client: pass `redis`, or set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN.",
    );
  }
  return new Redis({ url, token });
}

function receiverFromEnv(): Receiver {
  const currentSigningKey = process.env.QSTASH_CURRENT_SIGNING_KEY;
  const nextSigningKey = process.env.QSTASH_NEXT_SIGNING_KEY;
  if (!currentSigningKey || !nextSigningKey) {
    throw new Error(
      "createExecuteHandler needs signing keys: pass `receiver`, or set QSTASH_CURRENT_SIGNING_KEY and QSTASH_NEXT_SIGNING_KEY.",
    );
  }
  return new Receiver({ currentSigningKey, nextSigningKey });
}

function qstashFromEnv(): QStashClient {
  const token = process.env.QSTASH_TOKEN;
  if (!token) {
    throw new Error("QStashDispatcher needs a client: pass `qstash`, or set QSTASH_TOKEN.");
  }
  // QSTASH_URL points the client at the local dev server when one is running; the hosted URL is
  // the client's own default.
  return new QStashClient({ token, baseUrl: process.env.QSTASH_URL });
}
