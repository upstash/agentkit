/**
 * Test-only (never imported by `index.ts`): an in-memory stand-in for an Upstash Redis server and
 * the parts of the `@upstash/redis` client this package uses, for unit tests of ordering, batching,
 * splitting and errors that a real database cannot provoke on demand. Behaviour that only a real
 * server can confirm is covered by `integration.test.ts`.
 *
 * It mimics what matters about the HTTP client: every call is one request with a latency, a request
 * over `maxRequestBytes` is rejected the way Upstash rejects it, subscription messages are JSON-parsed
 * like `@upstash/redis` does by default, and a subscription is confirmed asynchronously.
 */
import type { Redis } from "@upstash/redis";

type Listener = (data: unknown) => void;

export interface MemoryRedisOptions {
  /** Simulated round trip per request. @default 0 */
  latencyMs?: number;
  /** Reject a request whose JSON body is larger than this. @default Infinity */
  maxRequestBytes?: number;
}

export interface RequestLog {
  /** `publish`, `pipeline`, `get`, ... */
  kind: string;
  /** Commands in the request. */
  commands: number;
  bytes: number;
}

const parseWithTryCatch = (value: string): unknown => {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class MemoryRedisServer {
  readonly requests: RequestLog[] = [];
  /** Every published message, per channel, in arrival order. */
  readonly published = new Map<string, string[]>();
  /** Make the next `n` requests fail. */
  failNext = 0;
  private readonly store = new Map<string, string>();
  private readonly subscribers = new Map<string, Set<(message: string) => void>>();

  constructor(private readonly options: MemoryRedisOptions = {}) {}

  subscriberCount(channel: string): number {
    return this.subscribers.get(channel)?.size ?? 0;
  }

  private async request(kind: string, body: unknown[][]): Promise<void> {
    const bytes = Buffer.byteLength(JSON.stringify(body.length === 1 ? body[0] : body));
    this.requests.push({ kind, commands: body.length, bytes });
    await sleep(this.options.latencyMs ?? 0);
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error("ERR simulated failure");
    }
    if (bytes > (this.options.maxRequestBytes ?? Infinity)) {
      throw new Error(`ERR max request size exceeded (${bytes} bytes)`);
    }
  }

  private publishNow(channel: string, message: string): number {
    if (message.includes("\n")) {
      // @upstash/redis splits the SSE response on newlines, so a raw newline would cut the message.
      throw new Error("a raw newline cannot cross an Upstash subscription");
    }
    this.published.set(channel, [...(this.published.get(channel) ?? []), message]);
    const subscribers = [...(this.subscribers.get(channel) ?? [])];
    for (const deliver of subscribers) deliver(message);
    return subscribers.length;
  }

  /** A client of this server, typed as the real one. */
  client(): Redis {
    const client = {
      publish: async (channel: string, message: string) => {
        await this.request("publish", [["publish", channel, message]]);
        return this.publishNow(channel, message);
      },
      pipeline: () => {
        const commands: [string, string][] = [];
        const pipeline = {
          publish: (channel: string, message: string) => {
            commands.push([channel, message]);
            return pipeline;
          },
          exec: async () => {
            await this.request(
              "pipeline",
              commands.map(([channel, message]) => ["publish", channel, message]),
            );
            return commands.map(([channel, message]) => this.publishNow(channel, message));
          },
        };
        return pipeline;
      },
      set: async (key: string, value: unknown) => {
        await this.request("set", [["set", key, String(value)]]);
        this.store.set(key, typeof value === "string" ? value : JSON.stringify(value));
        return "OK";
      },
      get: async (key: string) => {
        await this.request("get", [["get", key]]);
        const value = this.store.get(key);
        return value === undefined ? null : parseWithTryCatch(value);
      },
      exists: async (key: string) => {
        await this.request("exists", [["exists", key]]);
        return this.store.has(key) ? 1 : 0;
      },
      incr: async (key: string) => {
        await this.request("incr", [["incr", key]]);
        const next = Number(this.store.get(key) ?? 0) + 1;
        if (!Number.isInteger(next)) throw new Error("ERR value is not an integer or out of range");
        this.store.set(key, String(next));
        return next;
      },
      subscribe: (channel: string) => {
        const listeners = new Map<string, Set<Listener>>();
        const emit = (type: string, data: unknown) => {
          for (const listener of listeners.get(type) ?? []) listener(data);
        };
        // Deliveries are queued in order, like the lines of one SSE response.
        const deliver = (message: string) =>
          setTimeout(() => emit("message", { channel, message: parseWithTryCatch(message) }), 0);
        let active = true;
        void (async () => {
          try {
            await this.request("subscribe", [["subscribe", channel]]);
          } catch (error) {
            emit("error", error);
            return;
          }
          if (!active) return;
          const set = this.subscribers.get(channel) ?? new Set();
          set.add(deliver);
          this.subscribers.set(channel, set);
          emit("subscribe", set.size);
        })();
        return {
          on: (type: string, listener: Listener) => {
            listeners.set(type, (listeners.get(type) ?? new Set()).add(listener));
          },
          unsubscribe: async () => {
            active = false;
            this.subscribers.get(channel)?.delete(deliver);
            listeners.clear();
          },
        };
      },
    };
    return client as unknown as Redis;
  }
}
