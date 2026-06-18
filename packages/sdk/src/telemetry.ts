import { randomUUID } from "node:crypto";
import type { RedisLike } from "./types.js";
import { key } from "./utils.js";

export type SpanType = "run" | "model" | "tool" | "retrieval" | "custom";
export type SpanStatus = "ok" | "error" | "unset";

export interface SpanData {
  id: string;
  traceId: string;
  name: string;
  type: SpanType;
  startTime: number;
  endTime?: number;
  durationMs?: number;
  status: SpanStatus;
  attributes: Record<string, unknown>;
  error?: string;
}

export interface TelemetryConfig {
  redis: RedisLike;
  /** Key prefix; defaults to `agentkit:telemetry`. */
  namespace?: string;
  /** Expire trace data this many seconds after the last span is recorded. */
  ttlSeconds?: number;
  /** Injectable clock for deterministic tests. Defaults to `Date.now`. */
  clock?: () => number;
}

/** A live span. Mutate attributes during work, then call {@link Span.end} to persist it. */
export class Span {
  readonly data: SpanData;
  private telemetry: Telemetry;
  private ended = false;

  constructor(telemetry: Telemetry, data: SpanData) {
    this.telemetry = telemetry;
    this.data = data;
  }

  /** Attach a single attribute (e.g. `tokens`, `model`, `cacheHit`). */
  setAttribute(name: string, value: unknown): this {
    this.data.attributes[name] = value;
    return this;
  }

  /** Merge in multiple attributes. */
  setAttributes(attrs: Record<string, unknown>): this {
    Object.assign(this.data.attributes, attrs);
    return this;
  }

  /** Finish the span and persist it. Safe to call once. */
  async end(opts: { status?: SpanStatus; error?: unknown } = {}): Promise<SpanData> {
    if (this.ended) return this.data;
    this.ended = true;
    this.data.endTime = this.telemetry.clock();
    this.data.durationMs = this.data.endTime - this.data.startTime;
    if (opts.error !== undefined) {
      this.data.status = "error";
      this.data.error = opts.error instanceof Error ? opts.error.message : String(opts.error);
    } else {
      this.data.status = opts.status ?? "ok";
    }
    await this.telemetry.record(this.data);
    return this.data;
  }
}

/**
 * Collects structured spans for agent activity — runs, model calls, tool invocations, retrievals —
 * into Redis. Spans are grouped by `traceId` (one trace per agent run), stored in a sorted set keyed
 * by start time so a trace reads back in chronological order. Use it to measure latency, token usage,
 * and cache effectiveness.
 */
export class Telemetry {
  private redis: RedisLike;
  private namespace: string;
  private ttlSeconds?: number;
  /** @internal exposed for {@link Span}. */
  readonly clock: () => number;

  constructor(config: TelemetryConfig) {
    this.redis = config.redis;
    this.namespace = config.namespace ?? "agentkit:telemetry";
    this.ttlSeconds = config.ttlSeconds;
    this.clock = config.clock ?? (() => Date.now());
  }

  private traceKey(traceId: string): string {
    return key(this.namespace, "trace", traceId);
  }

  private indexKey(): string {
    return key(this.namespace, "traces");
  }

  /** Begin a new span. Provide a `traceId` to attach it to an existing trace, else one is created. */
  startSpan(
    name: string,
    opts: { traceId?: string; type?: SpanType; attributes?: Record<string, unknown> } = {},
  ): Span {
    return new Span(this, {
      id: randomUUID(),
      traceId: opts.traceId ?? randomUUID(),
      name,
      type: opts.type ?? "custom",
      startTime: this.clock(),
      status: "unset",
      attributes: opts.attributes ?? {},
    });
  }

  /** Persist a finished span. Usually called for you by {@link Span.end}. */
  async record(span: SpanData): Promise<void> {
    const k = this.traceKey(span.traceId);
    await this.redis.zadd(k, { score: span.startTime, member: JSON.stringify(span) });
    await this.redis.zadd(this.indexKey(), { score: span.startTime, member: span.traceId });
    if (this.ttlSeconds !== undefined) {
      await this.redis.expire(k, this.ttlSeconds);
    }
  }

  /** Read every span for a trace, in chronological order. */
  async getTrace(traceId: string): Promise<SpanData[]> {
    const raw = await this.redis.zrange<string | SpanData>(this.traceKey(traceId), 0, -1);
    return raw.map((r) => (typeof r === "string" ? (JSON.parse(r) as SpanData) : r));
  }

  /**
   * Convenience wrapper: run `fn` inside a span, recording success or the thrown error automatically.
   * The span is passed to `fn` so it can attach attributes mid-flight.
   */
  async trace<T>(
    name: string,
    fn: (span: Span) => Promise<T>,
    opts: { traceId?: string; type?: SpanType; attributes?: Record<string, unknown> } = {},
  ): Promise<T> {
    const span = this.startSpan(name, opts);
    try {
      const result = await fn(span);
      await span.end({ status: "ok" });
      return result;
    } catch (err) {
      await span.end({ error: err });
      throw err;
    }
  }
}
