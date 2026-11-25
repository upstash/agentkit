import { Redis } from "@upstash/redis";
import { addTelemetry } from "./telemetry.js";

const stopKey = (streamId: string) => `agentkit:stop:${streamId}`;

/** Asks the producer of `streamId` to stop, from any instance. One SET; the flag lives an hour. */
export async function requestStop(streamId: string, redis: Redis = Redis.fromEnv()): Promise<void> {
  addTelemetry(redis);
  await redis.set(stopKey(streamId), 1, { ex: 3600 });
}

/**
 * An `AbortSignal` for the producer, e.g. `streamText({ abortSignal })`, that aborts once
 * {@link requestStop} is called for `streamId`. It checks the flag with one EXISTS right away and
 * then every `pollIntervalMs` (1 command per second by default) until `dispose()` is called.
 */
export function createStopSignal(
  streamId: string,
  {
    redis = Redis.fromEnv(),
    pollIntervalMs = 1000,
  }: { redis?: Redis; pollIntervalMs?: number } = {},
): { signal: AbortSignal; dispose: () => void } {
  addTelemetry(redis);
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  const check = async () => {
    try {
      if ((await redis.exists(stopKey(streamId))) > 0) disposed = true;
      if (disposed) return controller.abort(new Error(`Stop requested for stream ${streamId}`));
    } catch (error) {
      console.warn(`[agentkit-resumable-stream] stop check for ${streamId} failed:`, error);
    }
    if (!disposed) timer = setTimeout(check, pollIntervalMs);
  };
  void check();
  return { signal: controller.signal, dispose: () => ((disposed = true), clearTimeout(timer)) };
}
