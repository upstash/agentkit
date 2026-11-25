import { Redis } from "@upstash/redis";
import { createResumableStreamContext as createGenericContext } from "resumable-stream/generic";
import type {
  CreateResumableStreamContextOptions,
  ResumableStreamContext,
} from "resumable-stream/generic";
import { createUpstashPublisher } from "./publisher.js";
import { createUpstashSubscriber } from "./subscriber.js";

/**
 * `createResumableStreamContext` from `resumable-stream/generic`, with an Upstash publisher and
 * subscriber unless you pass your own. `redis` defaults to `Redis.fromEnv()`.
 */
export function createResumableStreamContext(
  options: CreateResumableStreamContextOptions & { redis?: Redis },
): ResumableStreamContext {
  const { redis = Redis.fromEnv(), ...rest } = options;
  return createGenericContext({
    publisher: createUpstashPublisher(redis),
    subscriber: createUpstashSubscriber(redis),
    ...rest,
  });
}
