import { Redis } from "@upstash/redis";
import type { Publisher } from "resumable-stream/generic";
import { DONE_MESSAGE, encodeMessage, splitMessage } from "./codec.js";
import { addTelemetry } from "./telemetry.js";

const MAX_REQUEST_BYTES = 1024 * 1024;

interface Entry {
  payload: string;
  bytes: number;
  settle?: (receivers: number) => void;
}
interface Queue {
  entries: Entry[];
  failed?: boolean;
}

/**
 * resumable-stream's `Publisher` on `@upstash/redis`. Use with {@link createUpstashSubscriber}.
 *
 * - A message over `maxMessageBytes` is split into ordered pieces, so a large replay is not
 *   rejected for its size (vercel/resumable-stream#55).
 * - Publishes are queued per channel and resolve at once; the queue sends them in order, one
 *   pipeline request at a time, so the producer does not wait a round trip per chunk
 *   (vercel/resumable-stream#52). The DONE message waits until its channel is flushed.
 * - Publishes never reject: resumable-stream awaits them in the producer's read loop, so a
 *   rejection would freeze the original reader's stream too. A failed send is logged once, and
 *   that channel's unsent and later messages are dropped; its listener is broken anyway and
 *   resumable-stream's DONE watchdog closes it.
 */
export function createUpstashPublisher(
  redis: Redis = Redis.fromEnv(),
  { maxMessageBytes = 256 * 1024 }: { maxMessageBytes?: number } = {},
): Publisher {
  addTelemetry(redis);
  const queues = new Map<string, Queue>();
  const encoder = new TextEncoder();

  async function drain(channel: string, queue: Queue): Promise<void> {
    await Promise.resolve(); // let publishes from the same tick join the first request
    while (queue.entries.length > 0) {
      let [count, bytes] = [0, 0];
      while (count < queue.entries.length) {
        const next = (queue.entries[count] as Entry).bytes;
        if (count > 0 && bytes + next > MAX_REQUEST_BYTES) break;
        [count, bytes] = [count + 1, bytes + next];
      }
      const batch = queue.entries.splice(0, count);
      try {
        const pipeline = redis.pipeline();
        for (const entry of batch) pipeline.publish(channel, entry.payload);
        await pipeline.exec();
        for (const entry of batch) entry.settle?.(1);
      } catch (error) {
        queue.failed = true;
        console.error(`[agentkit-resumable-stream] publish to ${channel} failed:`, error);
        for (const entry of [...batch, ...queue.entries.splice(0)]) entry.settle?.(0);
        return;
      }
    }
    queues.delete(channel);
  }

  return {
    connect: async () => undefined,
    publish: (channel, message) => {
      let queue = queues.get(channel);
      if (queue?.failed) {
        if (message === DONE_MESSAGE) queues.delete(channel);
        return Promise.resolve(0);
      }
      const idle = !queue;
      if (!queue) queues.set(channel, (queue = { entries: [] }));
      const entries = queue.entries;
      const sent = new Promise<number>((resolve) => {
        const pieces = splitMessage(message, maxMessageBytes);
        pieces.forEach((piece, i) => {
          const payload = encodeMessage(piece);
          const settle = i === pieces.length - 1 ? resolve : undefined;
          entries.push({ payload, bytes: encoder.encode(payload).byteLength, settle });
        });
      });
      if (idle) void drain(channel, queue);
      return message === DONE_MESSAGE ? sent : Promise.resolve(1);
    },
    set: (key, value, options) =>
      options?.EX ? redis.set(key, value, { ex: options.EX }) : redis.set(key, value),
    get: async (key) => (await redis.get<string | number>(key)) ?? null,
    incr: (key) => redis.incr(key),
  };
}
