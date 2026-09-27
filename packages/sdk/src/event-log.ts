import type { Redis } from "@upstash/redis";
import { addTelemetry } from "./telemetry.js";

/**
 * Every stored event carries this prefix. `@upstash/redis` auto-deserializes replies, so a field
 * holding valid JSON (`"hi"`, `123`) would come back as a different type; the prefix makes every
 * stored value unparseable as JSON and guarantees a byte-exact round trip.
 */
const MARKER = "agentkit-event-v1:";

export interface EventLogConfig {
  /** Upstash Redis client. */
  redis: Redis;
  /** Base key prefix. Defaults to `agentkit:log`. */
  prefix?: string;
  /**
   * Expiry applied to a log on every append and on close, in seconds, so logs whose producer died
   * without closing still go away. `0` disables expiry.
   * @default 86400
   */
  ttlSeconds?: number;
  /**
   * How often a tailing {@link EventLog.read} polls for new entries, in ms. Blocking reads span
   * requests, which the REST API does not keep, so tailing is a poll.
   * @default 250
   */
  pollIntervalMs?: number;
  /**
   * Report the sdk name + version to Upstash as a header on the requests made by your redis client.
   * Can also be disabled with the `UPSTASH_DISABLE_TELEMETRY` env var. Defaults to `true`.
   */
  enableTelemetry?: boolean;
}

/** One stored event and its position. `id` is the Redis Stream entry id, opaque to callers. */
export interface LogEntry<T> {
  id: string;
  event: T;
}

function assertLogId(logId: string): void {
  if (typeof logId !== "string" || logId === "" || /[\r\n]/.test(logId)) {
    throw new Error("EventLog: `logId` must be a non-empty string without CR/LF.");
  }
}

const PAGE = 500;

/**
 * An append-only, resumable event log on Upstash Redis Streams — the storage under resumable
 * streaming (reload mid-answer, a second device joining), fan-out to several readers, and replay.
 *
 * - `append` writes a batch atomically (one `MULTI`) and returns one position per event, in order.
 * - `read` yields everything **after** a position and keeps tailing until the log is closed.
 * - `snapshot` returns what is stored right now and never waits.
 * - `close` terminalizes the log; readers drain what is left and stop.
 *
 * Keys: `<prefix>:events:<logId>` (the stream) and `<prefix>:closed:<logId>` (the terminal flag).
 */
export class EventLog<T = unknown> {
  private redis: Redis;
  private prefix: string;
  private ttlSeconds: number;
  private pollIntervalMs: number;

  constructor(config: EventLogConfig) {
    this.redis = config.redis;
    addTelemetry(config.redis, { enabled: config.enableTelemetry });
    this.prefix = config.prefix ?? "agentkit:log";
    this.ttlSeconds = config.ttlSeconds ?? 86_400;
    this.pollIntervalMs = config.pollIntervalMs ?? 250;
  }

  private streamKey(logId: string): string {
    return `${this.prefix}:events:${logId}`;
  }

  private closedKey(logId: string): string {
    return `${this.prefix}:closed:${logId}`;
  }

  private decode(fields: unknown): T {
    const raw = (fields as { e?: unknown } | null)?.e;
    if (typeof raw !== "string" || !raw.startsWith(MARKER)) {
      throw new Error("EventLog: stored entry is not an EventLog event.");
    }
    return JSON.parse(raw.slice(MARKER.length)) as T;
  }

  /** Append a batch atomically; returns one position per event, in the same order. */
  async append(logId: string, events: T[]): Promise<string[]> {
    assertLogId(logId);
    if (events.length === 0) return [];
    const key = this.streamKey(logId);
    const tx = this.redis.multi();
    for (const event of events) tx.xadd(key, "*", { e: MARKER + JSON.stringify(event) });
    if (this.ttlSeconds > 0) tx.expire(key, this.ttlSeconds);
    const results = (await tx.exec()) as unknown[];
    return results.slice(0, events.length).map(String);
  }

  /** One page of entries strictly after `after` (`"0"` = from the start). */
  private async page(logId: string, after: string, count = PAGE): Promise<LogEntry<T>[]> {
    const start = after === "0" ? "-" : `(${after}`;
    const rows = (await this.redis.xrange(this.streamKey(logId), start, "+", count)) as Record<
      string,
      unknown
    >;
    // Stream ids are not integer-like strings, so object key order is insertion (= stream) order.
    return Object.entries(rows ?? {}).map(([id, fields]) => ({ id, event: this.decode(fields) }));
  }

  /** Everything stored right now, in append order. Never waits; `[]` for an unknown log. */
  async snapshot(logId: string): Promise<LogEntry<T>[]> {
    assertLogId(logId);
    const out: LogEntry<T>[] = [];
    let after = "0";
    for (;;) {
      const rows = await this.page(logId, after);
      out.push(...rows);
      if (rows.length < PAGE) return out;
      after = rows[rows.length - 1]!.id;
    }
  }

  /** The position of the last stored entry, or `null` for an empty/unknown log. */
  async tail(logId: string): Promise<string | null> {
    assertLogId(logId);
    const rows = (await this.redis.xrevrange(this.streamKey(logId), "+", "-", 1)) as Record<
      string,
      unknown
    >;
    return Object.keys(rows ?? {})[0] ?? null;
  }

  /** Mark the log complete. Readers drain what is stored and then stop. Idempotent. */
  async close(logId: string): Promise<void> {
    assertLogId(logId);
    const tx = this.redis.multi();
    if (this.ttlSeconds > 0) {
      tx.set(this.closedKey(logId), "1", { ex: this.ttlSeconds });
      tx.expire(this.streamKey(logId), this.ttlSeconds);
    } else {
      tx.set(this.closedKey(logId), "1");
    }
    await tx.exec();
  }

  /** Whether {@link EventLog.close} has been called for this log. */
  async isClosed(logId: string): Promise<boolean> {
    assertLogId(logId);
    return (await this.redis.exists(this.closedKey(logId))) === 1;
  }

  /** Delete the log and its closed flag. */
  async delete(logId: string): Promise<void> {
    assertLogId(logId);
    await this.redis.del(this.streamKey(logId), this.closedKey(logId));
  }

  /**
   * Yield every entry strictly after `after` (default: from the start), then keep tailing until the
   * log is closed or `signal` aborts. Closing is checked only once the reader has caught up, and a
   * final drain runs after it is seen, so nothing appended before `close` is skipped.
   *
   * `firstEntryTimeoutMs` bounds the wait for a log that has no entries at all yet (a joiner that
   * attached to a run that never produced) — it rejects instead of parking forever.
   */
  async *read(
    logId: string,
    opts: {
      after?: string;
      signal?: AbortSignal;
      pollIntervalMs?: number;
      firstEntryTimeoutMs?: number;
    } = {},
  ): AsyncGenerator<LogEntry<T>> {
    assertLogId(logId);
    const poll = opts.pollIntervalMs ?? this.pollIntervalMs;
    let after = opts.after ?? "0";
    let seenAny = after !== "0";
    const startedAt = Date.now();
    for (;;) {
      if (opts.signal?.aborted) return;
      const rows = await this.page(logId, after);
      for (const row of rows) {
        seenAny = true;
        after = row.id;
        yield row;
        if (opts.signal?.aborted) return;
      }
      if (rows.length === PAGE) continue;
      if (await this.isClosed(logId)) {
        // Anything appended between the page above and the close is picked up here.
        for (;;) {
          const rest = await this.page(logId, after);
          for (const row of rest) {
            after = row.id;
            yield row;
          }
          if (rest.length < PAGE) return;
        }
      }
      if (
        !seenAny &&
        opts.firstEntryTimeoutMs !== undefined &&
        Date.now() - startedAt >= opts.firstEntryTimeoutMs
      ) {
        throw new Error(
          `EventLog: log ${JSON.stringify(logId)} produced no entries within ${opts.firstEntryTimeoutMs}ms.`,
        );
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, poll);
        function done() {
          clearTimeout(timer);
          opts.signal?.removeEventListener("abort", done);
          resolve();
        }
        opts.signal?.addEventListener("abort", done, { once: true });
      });
    }
  }
}
