/**
 * The Upstash backends this app runs on. Every one of them is shared state in Upstash Redis, which
 * is the point: any server instance can serve any request for any thread.
 *
 * Created on first use, not at import, so `next build` (which loads route modules) needs no
 * credentials.
 */
import { Redis } from "@upstash/redis";
import { RedisLock, upstashStream } from "@upstash/agentkit-tanstack-ai";
import { upstashPersistence } from "@upstash/agentkit-tanstack-ai/persistence";
import { upstashMemory } from "@upstash/agentkit-tanstack-ai/memory";

/** `DEMO_PREFIX` isolates a run's keys (the E2E suite sets one per run). */
const prefix = () => process.env.DEMO_PREFIX ?? "tanstack-ai-demo";

function create() {
  const redis = Redis.fromEnv();
  return {
    redis,
    /** Transcripts, run records and interrupts — what `reconstructChat` rebuilds a reload from. */
    persistence: upstashPersistence({ redis, prefix: `${prefix()}:state` }),
    /** Long-term memory, per user across threads. */
    memory: upstashMemory({ redis }),
    /**
     * "Only one producer per run", across instances: a duplicate POST for the same run (a client
     * retry landing on another server) must not start a second model run into the same log.
     */
    producerLock: new RedisLock({ redis, prefix: `${prefix()}:producer`, leaseMs: 10 * 60_000 }),
  };
}

let instance: ReturnType<typeof create> | undefined;
export const backends = () => (instance ??= create());

/** The durable delivery log of one run, on Redis Streams. */
export function runLog(source: Request | { runId: string; offset?: string | null }) {
  return upstashStream(source, {
    redis: backends().redis,
    prefix: `${prefix()}:stream`,
    // A reader that joins a run the moment it is started may briefly beat the first chunk.
    firstChunkDeadlineMs: 10_000,
  });
}
