import { Redis } from "@upstash/redis";
import { assertId } from "./active-stream-store.js";
import { addTelemetry } from "./telemetry.js";

/** Options shared by {@link requestStop} and {@link createStopSignal}. */
export interface StopConfig {
  /** Upstash Redis client. Defaults to `Redis.fromEnv()`. */
  redis?: Redis;
  /** Key prefix; a stream's stop flag is at `<prefix>:<streamId>`. @default "agentkit:stop" */
  prefix?: string;
  /** Report this package in the redis client's telemetry header. @default true */
  enableTelemetry?: boolean;
}

/** Options of {@link requestStop}. */
export interface RequestStopOptions extends StopConfig {
  /**
   * How long the stop flag lives. It only has to outlast the generation it stops.
   * @default 3600
   */
  ttlSeconds?: number;
}

/** Options of {@link createStopSignal}. */
export interface StopSignalOptions extends StopConfig {
  /**
   * How often the producer checks the stop flag. Each check is one `EXISTS`, so a producer costs
   * `1000 / pollIntervalMs` commands per second while it runs (1 per second by default).
   * @default 1000
   */
  pollIntervalMs?: number;
  /** Also abort when this signal aborts, e.g. `request.signal` on a server that cancels work. */
  signal?: AbortSignal;
  /** Called when a check fails; polling continues. Defaults to `console.warn`. */
  onError?: (error: unknown) => void;
}

/** The producer's side of a stop: pass `signal` to the work, call `dispose` when it ends. */
export interface StopSignal {
  /** Aborts with a {@link StopRequestedError} once {@link requestStop} is called for the stream. */
  signal: AbortSignal;
  /** Stops polling. Call it when the generation finishes. Safe to call twice. */
  dispose: () => void;
}

/** The abort reason of a {@link createStopSignal} signal when a stop was requested. */
export class StopRequestedError extends Error {
  readonly streamId: string;
  constructor(streamId: string) {
    super(`Stop requested for stream ${streamId}`);
    this.name = "StopRequestedError";
    this.streamId = streamId;
  }
}

const DEFAULT_PREFIX = "agentkit:stop";

const stopKey = (prefix: string, streamId: string) => {
  assertId(streamId, "streamId");
  return `${prefix}:${streamId}`;
};

/**
 * Asks the producer of `streamId` to stop, from any instance: sets a flag that the producer's
 * {@link createStopSignal} picks up on its next check. One `SET`.
 */
export async function requestStop(
  streamId: string,
  options: RequestStopOptions = {},
): Promise<void> {
  const {
    redis = Redis.fromEnv(),
    prefix = DEFAULT_PREFIX,
    ttlSeconds = 60 * 60,
    enableTelemetry,
  } = options;
  addTelemetry(redis, enableTelemetry);
  await redis.set(stopKey(prefix, streamId), 1, { ex: ttlSeconds });
}

/**
 * An `AbortSignal` that aborts when {@link requestStop} is called for `streamId` on any instance.
 * Pass it to the work that produces the stream, e.g. AI SDK `streamText({ abortSignal })`, and
 * call `dispose()` when the work ends.
 *
 * It polls a Redis key: one `EXISTS` right away, then one every `pollIntervalMs` (default 1000),
 * so a stop takes effect within about one interval plus a round trip. A long-lived SUBSCRIBE would
 * react sooner, but over HTTP it holds a request open per producer and is lost silently if that
 * request drops; a poll costs a known number of commands and cannot miss a stop.
 */
export function createStopSignal(streamId: string, options: StopSignalOptions = {}): StopSignal {
  const {
    redis = Redis.fromEnv(),
    prefix = DEFAULT_PREFIX,
    pollIntervalMs = 1000,
    signal: parent,
    onError = (error: unknown) =>
      console.warn(`[agentkit-resumable-stream] stop check for ${streamId} failed:`, error),
    enableTelemetry,
  } = options;
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0) {
    throw new RangeError(`pollIntervalMs must be a positive number, got ${pollIntervalMs}`);
  }
  const key = stopKey(prefix, streamId);
  addTelemetry(redis, enableTelemetry);

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  const onParentAbort = () => abort(parent?.reason);

  function dispose(): void {
    disposed = true;
    clearTimeout(timer);
    parent?.removeEventListener("abort", onParentAbort);
  }

  function abort(reason: unknown): void {
    dispose();
    if (!controller.signal.aborted) controller.abort(reason);
  }

  async function check(): Promise<void> {
    if (disposed) return;
    try {
      if ((await redis.exists(key)) > 0 && !disposed)
        return abort(new StopRequestedError(streamId));
    } catch (error) {
      if (!disposed) onError(error);
    }
    if (disposed) return;
    timer = setTimeout(() => void check(), pollIntervalMs);
    // Do not keep a Node process alive just to poll.
    (timer as { unref?: () => void }).unref?.();
  }

  if (parent?.aborted) abort(parent.reason);
  else {
    parent?.addEventListener("abort", onParentAbort, { once: true });
    void check();
  }

  return { signal: controller.signal, dispose };
}
