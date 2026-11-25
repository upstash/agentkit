import { Redis } from "@upstash/redis";
import type { Publisher } from "resumable-stream/generic";
import { DONE_MESSAGE, encodeMessage, splitMessage, utf8Length } from "./codec.js";
import { addTelemetry } from "./telemetry.js";

/** Options of {@link createUpstashPublisher}. */
export interface UpstashPublisherOptions {
  /**
   * The largest message, in UTF-8 bytes of its envelope, published in one PUBLISH. A longer one
   * (typically the replay of everything buffered so far, sent when a client resumes) is split into
   * ordered pieces on the same channel. Keep it well under your plan's max request size and under
   * the 1 MiB that `@upstash/redis` buffers per subscription message.
   * @default 262144 (256 KiB)
   */
  maxMessageBytes?: number;
  /**
   * The most message bytes sent in one pipeline request when publishes are batched.
   * @default 1048576 (1 MiB)
   */
  maxBatchBytes?: number;
  /**
   * Batch publishes. A publish is queued per channel and resolves at once, and the queue sends what
   * accumulates through one pipeline request at a time, in order. resumable-stream awaits each
   * publish before it reads the next chunk, so without this a producer with a resumed listener
   * reads one chunk per HTTP round trip. The DONE message still waits until everything queued
   * before it on its channel is sent. Set `false` to make every publish wait for its own request.
   * @default true
   */
  batch?: boolean;
  /**
   * Called when a queued publish fails. That channel then stays failed: its later publishes, and
   * its DONE message, reject with the same error. Defaults to `console.error`.
   */
  onError?: (error: unknown, channel: string) => void;
  /** Report this package in the redis client's telemetry header. @default true */
  enableTelemetry?: boolean;
}

/** A resumable-stream {@link Publisher} on Upstash Redis. */
export interface UpstashPublisher extends Publisher {
  /** Resolves once every publish queued so far has been sent (or has failed). */
  flush: () => Promise<void>;
}

interface Entry {
  payload: string;
  bytes: number;
  /** Only the last piece of a message settles the publish that queued it. */
  settle?: { resolve: (receivers: number) => void; reject: (error: unknown) => void };
}

interface ChannelQueue {
  entries: Entry[];
  draining: Promise<void> | null;
  failed: boolean;
  error: unknown;
}

const DEFAULT_MAX_MESSAGE_BYTES = 256 * 1024;
const DEFAULT_MAX_BATCH_BYTES = 1024 * 1024;

/**
 * A resumable-stream `Publisher` on `@upstash/redis` (HTTP), for `resumable-stream/generic`. Use it
 * with {@link createUpstashSubscriber}: messages are published in an envelope the subscriber
 * unwraps.
 *
 * - **Large messages** are split into ordered pieces of at most `maxMessageBytes`, so the replay a
 *   resuming client gets is never rejected for its size.
 * - **Publishes are batched** per channel (see `batch`), so a producer does not wait one round
 *   trip per chunk while a client is resumed.
 *
 * @param redis Upstash Redis client. Defaults to `Redis.fromEnv()`.
 */
export function createUpstashPublisher(
  redis: Redis = Redis.fromEnv(),
  options: UpstashPublisherOptions = {},
): UpstashPublisher {
  const {
    maxMessageBytes = DEFAULT_MAX_MESSAGE_BYTES,
    maxBatchBytes = DEFAULT_MAX_BATCH_BYTES,
    batch = true,
    onError = (error: unknown, channel: string) =>
      console.error(`[agentkit-resumable-stream] publish to ${channel} failed:`, error),
    enableTelemetry,
  } = options;
  // Validates maxMessageBytes up front instead of on the first large message.
  splitMessage("", maxMessageBytes);
  addTelemetry(redis, enableTelemetry);

  const queues = new Map<string, ChannelQueue>();

  async function send(channel: string, entries: Entry[]): Promise<number> {
    if (entries.length === 1) return redis.publish(channel, (entries[0] as Entry).payload);
    const pipeline = redis.pipeline();
    for (const entry of entries) pipeline.publish(channel, entry.payload);
    const results = (await pipeline.exec()) as number[];
    return results[results.length - 1] ?? 0;
  }

  /** Takes the next batch off the queue: at least one entry, then as many as fit in maxBatchBytes. */
  function takeBatch(entries: Entry[]): Entry[] {
    let bytes = (entries[0] as Entry).bytes;
    let count = 1;
    while (count < entries.length && bytes + (entries[count] as Entry).bytes <= maxBatchBytes) {
      bytes += (entries[count] as Entry).bytes;
      count++;
    }
    return entries.splice(0, count);
  }

  async function drain(channel: string, queue: ChannelQueue): Promise<void> {
    // Let publishes issued in the same tick (a replay and its DONE, say) join the first request.
    await Promise.resolve();
    try {
      while (queue.entries.length > 0) {
        const entries = takeBatch(queue.entries);
        let receivers: number;
        try {
          receivers = await send(channel, entries);
        } catch (error) {
          queue.failed = true;
          queue.error = error;
          for (const entry of [...entries, ...queue.entries.splice(0)]) entry.settle?.reject(error);
          onError(error, channel);
          return;
        }
        for (const entry of entries) entry.settle?.resolve(receivers);
      }
    } finally {
      queue.draining = null;
      if (!queue.failed && queue.entries.length === 0 && queues.get(channel) === queue) {
        queues.delete(channel);
      }
    }
  }

  function enqueue(channel: string, message: string): Promise<number> {
    let queue = queues.get(channel);
    if (!queue) {
      queue = { entries: [], draining: null, failed: false, error: undefined };
      queues.set(channel, queue);
    }
    const pieces = splitMessage(message, maxMessageBytes);
    const target = queue;
    const settled = new Promise<number>((resolve, reject) => {
      pieces.forEach((piece, index) => {
        const payload = encodeMessage(piece);
        target.entries.push({
          payload,
          bytes: utf8Length(payload) + utf8Length(channel),
          settle: index === pieces.length - 1 ? { resolve, reject } : undefined,
        });
      });
    });
    if (!queue.draining) queue.draining = drain(channel, queue);
    return settled;
  }

  return {
    connect: async () => undefined,

    publish: (channel, message) => {
      const failed = queues.get(channel);
      if (failed?.failed) {
        // The channel is finished once its DONE message is attempted; forget it.
        if (message === DONE_MESSAGE) queues.delete(channel);
        return Promise.reject(failed.error);
      }
      const sent = enqueue(channel, message);
      // The DONE message closes the listener's stream, so everything before it must be sent first,
      // and the producer's `waitUntil` lasts until it is.
      if (!batch || message === DONE_MESSAGE) return sent;
      // Resolved now; a failure is reported through onError and rejects the channel's next publish.
      sent.catch(() => undefined);
      return Promise.resolve(1);
    },

    set: (key, value, options) =>
      options?.EX !== undefined ? redis.set(key, value, { ex: options.EX }) : redis.set(key, value),

    get: async (key) => {
      const value = await redis.get<string | number>(key);
      return value ?? null;
    },

    incr: (key) => redis.incr(key),

    flush: async () => {
      for (;;) {
        const pending = [...queues.values()]
          .map((queue) => queue.draining)
          .filter((draining): draining is Promise<void> => draining !== null);
        if (pending.length === 0) return;
        await Promise.all(pending);
      }
    },
  };
}
