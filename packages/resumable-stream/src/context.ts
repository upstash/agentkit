import { Redis } from "@upstash/redis";
import { createResumableStreamContext as createGenericContext } from "resumable-stream/generic";
import type { Publisher, ResumableStreamContext, Subscriber } from "resumable-stream/generic";
import { createUpstashPublisher } from "./publisher.js";
import type { UpstashPublisherOptions } from "./publisher.js";
import { createUpstashSubscriber } from "./subscriber.js";
import type { UpstashSubscriberOptions } from "./subscriber.js";

/** Options of {@link createResumableStreamContext}. */
export interface UpstashResumableStreamContextOptions {
  /**
   * Keeps the program alive until a promise settles, e.g. `after` from `next/server` or
   * `waitUntil` from `@vercel/functions`. Pass `null` on a long-running server.
   */
  waitUntil: ((promise: Promise<unknown>) => void) | null;
  /** Prefix of resumable-stream's keys and channels. @default "resumable-stream" */
  keyPrefix?: string;
  /**
   * How often a resumed stream re-checks the DONE sentinel in case the DONE message was lost (one
   * GET per check). Passed to resumable-stream, which ignores it before 2.2.13.
   * @default 10000
   */
  doneWatchdogIntervalMs?: number;
  /** Upstash Redis client for the default publisher and subscriber. Defaults to `Redis.fromEnv()`. */
  redis?: Redis;
  /** Use this publisher instead of {@link createUpstashPublisher}. */
  publisher?: Publisher;
  /** Use this subscriber instead of {@link createUpstashSubscriber}. */
  subscriber?: Subscriber;
  /** Options of the default publisher. */
  publisherOptions?: Omit<UpstashPublisherOptions, "enableTelemetry">;
  /** Options of the default subscriber. */
  subscriberOptions?: Omit<UpstashSubscriberOptions, "enableTelemetry">;
  /** Report this package in the redis client's telemetry header. @default true */
  enableTelemetry?: boolean;
}

/**
 * `createResumableStreamContext` from `resumable-stream/generic`, wired to Upstash Redis over HTTP:
 * it works on serverless and edge runtimes, where a TCP Redis client does not. Everything else is
 * resumable-stream's own behaviour.
 *
 * ```ts
 * import { after } from "next/server";
 * import { createResumableStreamContext } from "@upstash/agentkit-resumable-stream";
 *
 * const streamContext = createResumableStreamContext({ waitUntil: after });
 * ```
 */
export function createResumableStreamContext(
  options: UpstashResumableStreamContextOptions,
): ResumableStreamContext {
  const {
    waitUntil,
    keyPrefix,
    doneWatchdogIntervalMs,
    redis,
    publisher,
    subscriber,
    publisherOptions,
    subscriberOptions,
    enableTelemetry,
  } = options;
  const client = publisher && subscriber ? undefined : (redis ?? Redis.fromEnv());
  return createGenericContext({
    waitUntil,
    keyPrefix,
    doneWatchdogIntervalMs,
    publisher:
      publisher ?? createUpstashPublisher(client, { ...publisherOptions, enableTelemetry }),
    subscriber:
      subscriber ?? createUpstashSubscriber(client, { ...subscriberOptions, enableTelemetry }),
  });
}
