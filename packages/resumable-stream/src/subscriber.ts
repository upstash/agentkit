import { Redis } from "@upstash/redis";
import type { Subscriber } from "resumable-stream/generic";
import { decodeMessage } from "./codec.js";
import { addTelemetry } from "./telemetry.js";

/** Options of {@link createUpstashSubscriber}. */
export interface UpstashSubscriberOptions {
  /**
   * How long `subscribe` waits for Upstash to confirm the subscription before it rejects.
   * resumable-stream publishes right after subscribing, so `subscribe` only resolves once the
   * subscription is live.
   * @default 10000
   */
  subscribeTimeoutMs?: number;
  /**
   * Called when a live subscription reports an error, or when the message callback throws.
   * Defaults to `console.error`.
   */
  onError?: (error: unknown, channel: string) => void;
  /** Report this package in the redis client's telemetry header. @default true */
  enableTelemetry?: boolean;
}

/** A resumable-stream {@link Subscriber} on Upstash Redis. */
export interface UpstashSubscriber extends Subscriber {
  /** The channels with a live subscription. */
  channels: () => string[];
  /** Closes every subscription. */
  close: () => Promise<void>;
}

/** What this module uses of `@upstash/redis`'s subscription object. */
interface Subscription {
  on(type: "message", listener: (event: { channel: string; message: unknown }) => void): void;
  on(type: "subscribe", listener: (count: number) => void): void;
  on(type: "error", listener: (error: Error) => void): void;
  unsubscribe(channels?: string[]): Promise<void>;
}

const DEFAULT_SUBSCRIBE_TIMEOUT_MS = 10_000;

/**
 * A resumable-stream `Subscriber` on `@upstash/redis` (HTTP), for `resumable-stream/generic`. Use
 * it with {@link createUpstashPublisher}, whose message envelope it unwraps.
 *
 * Upstash serves SUBSCRIBE over HTTP as a Server-Sent Events response, so each subscribed channel
 * holds one HTTP request open. `subscribe` resolves once Upstash confirms the subscription;
 * `unsubscribe` aborts that request, which ends the subscription on the server.
 *
 * Channel names cannot contain a comma (`@upstash/redis` parses `message,<channel>,<message>`),
 * so neither can the stream ids passed to resumable-stream; `subscribe` rejects them.
 *
 * @param redis Upstash Redis client. Defaults to `Redis.fromEnv()`.
 */
export function createUpstashSubscriber(
  redis: Redis = Redis.fromEnv(),
  options: UpstashSubscriberOptions = {},
): UpstashSubscriber {
  const {
    subscribeTimeoutMs = DEFAULT_SUBSCRIBE_TIMEOUT_MS,
    onError = (error: unknown, channel: string) =>
      console.error(`[agentkit-resumable-stream] subscription to ${channel} failed:`, error),
    enableTelemetry,
  } = options;
  addTelemetry(redis, enableTelemetry);

  const subscriptions = new Map<string, Subscription>();

  async function close(channel: string, subscription: Subscription): Promise<void> {
    if (subscriptions.get(channel) === subscription) subscriptions.delete(channel);
    // Without arguments it aborts the HTTP request and drops every listener.
    await subscription.unsubscribe();
  }

  return {
    connect: async () => undefined,

    subscribe: async (channel, callback) => {
      if (channel.includes(",")) {
        throw new Error(
          `Upstash subscriptions cannot use a channel name with a comma: ${JSON.stringify(channel)}`,
        );
      }
      const previous = subscriptions.get(channel);
      if (previous) await close(channel, previous);

      const subscription = redis.subscribe<unknown>(channel) as unknown as Subscription;
      subscriptions.set(channel, subscription);

      let confirmed = false;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`Timed out after ${subscribeTimeoutMs}ms subscribing to ${channel}`));
        }, subscribeTimeoutMs);
        subscription.on("subscribe", () => {
          confirmed = true;
          clearTimeout(timer);
          resolve();
        });
        subscription.on("error", (error) => {
          if (confirmed) return onError(error, channel);
          clearTimeout(timer);
          reject(error);
        });
        subscription.on("message", ({ message }) => {
          try {
            const result: unknown = callback(decodeMessage(message));
            if (result instanceof Promise) result.catch((error) => onError(error, channel));
          } catch (error) {
            onError(error, channel);
          }
        });
      }).catch(async (error) => {
        await close(channel, subscription).catch(() => undefined);
        throw error;
      });
    },

    unsubscribe: async (channel) => {
      const subscription = subscriptions.get(channel);
      if (subscription) await close(channel, subscription);
    },

    channels: () => [...subscriptions.keys()],

    close: async () => {
      await Promise.all([...subscriptions].map(([channel, sub]) => close(channel, sub)));
    },
  };
}
