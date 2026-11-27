import { Redis } from "@upstash/redis";
import type { Subscriber } from "resumable-stream/generic";
import { decodeMessage } from "./codec.js";
import { addTelemetry } from "./telemetry.js";

type Subscription = ReturnType<Redis["subscribe"]>;

/**
 * resumable-stream's `Subscriber` on `@upstash/redis`. Use with {@link createUpstashPublisher}.
 *
 * Upstash serves SUBSCRIBE over HTTP (Server-Sent Events), one open request per channel.
 * `subscribe` resolves once Upstash confirms the subscription, since resumable-stream publishes
 * right after it; `unsubscribe` aborts the request. Stream ids cannot contain a comma
 * (`@upstash/redis` parses `message,<channel>,<message>`).
 */
export function createUpstashSubscriber(redis: Redis = Redis.fromEnv()): Subscriber {
  addTelemetry(redis);
  const subscriptions = new Map<string, Subscription>();

  return {
    connect: async () => undefined,
    subscribe: async (channel, callback) => {
      if (channel.includes(","))
        throw new Error(`Channel names cannot contain a comma: ${channel}`);
      const subscription = redis.subscribe<unknown>(channel);
      subscriptions.set(channel, subscription);
      subscription.on("message", ({ message }) => callback(decodeMessage(message)));
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`Subscribing to ${channel} timed out`)),
          10_000,
        );
        subscription.on("subscribe", () => {
          clearTimeout(timer);
          resolve();
        });
        subscription.on("error", (error) => {
          clearTimeout(timer);
          reject(error); // a no-op once subscribed
          console.error(`[agentkit-resumable-stream] subscription to ${channel} failed:`, error);
        });
      }).catch(async (error) => {
        subscriptions.delete(channel);
        await subscription.unsubscribe();
        throw error;
      });
    },
    unsubscribe: async (channel) => {
      const subscription = subscriptions.get(channel);
      subscriptions.delete(channel);
      await subscription?.unsubscribe(); // aborts the HTTP request and drops the listeners
    },
  };
}
