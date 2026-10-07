/**
 * The storage and delivery seams of the events runtime.
 *
 * MCP Events says how a host subscribes and what a delivery looks like on the wire. It says
 * nothing about where subscriptions live or how a webhook is retried, so those are two
 * interfaces: a {@link SubscriptionStore} owns the subscription records, an {@link EventDelivery}
 * owns getting a signed POST to the callback. Upstash Redis + QStash (`upstash.ts`) are one
 * implementation of each; the in-memory ones (`backends/memory.ts`) are for tests and local dev.
 */

/** The envelope POSTed to a callback URL, as the MCP Events draft defines it. */
export type EventEnvelope<TData = unknown> = {
  /** Stable across retries, so the host can drop duplicates. Also sent as `webhook-id`. */
  eventId: string;
  /** The event name, e.g. `comment.created`. */
  name: string;
  /** ISO-8601, when the event happened. */
  timestamp: string;
  /** The payload, matching the event's `payloadSchema`. */
  data: TData;
  /** Replay cursor. This runtime does not replay, so it is always `null`. */
  cursor: string | null;
};

/** One webhook subscription, as stored. The signing secret is stored encrypted. */
export type Subscription = {
  /** Deterministic: derived from the owner, callback URL, event name and arguments. */
  id: string;
  /** The event name. */
  event: string;
  /** The validated subscription arguments. */
  args: Record<string, unknown>;
  /** Canonical JSON of {@link args}; the key emits are matched on. */
  argsKey: string;
  /** The callback URL the host gave. */
  url: string;
  /** The `whsec_` signing secret, encrypted with the layer's `secretKey`. */
  encryptedSecret: string;
  /** The caller that subscribed, from `EventLayerOptions.principal`. */
  owner?: string;
  /** ISO-8601. */
  createdAt: string;
  /** Epoch milliseconds after which the subscription is gone. */
  expiresAt: number;
};

/**
 * Durable storage for subscriptions.
 *
 * Matching is by exact canonical arguments: a subscription to `{ repo: "a" }` is found under the
 * key `{"repo":"a"}`. The layer computes every key an emit could match (each subset of the emitted
 * arguments, including `{}`) and asks the store for all of them at once, so a store only needs an
 * index from `(event, argsKey)` to live subscriptions.
 */
export interface SubscriptionStore {
  /** Creates or replaces a subscription. Must have committed before it resolves. */
  put(subscription: Subscription): Promise<void>;
  /** Returns a live subscription, or `null` when it is absent or expired. */
  get(id: string): Promise<Subscription | null>;
  /** Removes a subscription. A no-op when it does not exist. */
  delete(id: string): Promise<void>;
  /** Returns every live subscription to `event` whose `argsKey` is one of `argsKeys`. */
  find(event: string, argsKeys: string[]): Promise<Subscription[]>;
}

/** What the transport is asked to send: one envelope to one subscription. */
export type DeliveryJob = {
  subscriptionId: string;
  envelope: EventEnvelope;
};

/** The outcome of one POST to a callback, as the layer classifies it. */
export type SendOutcome =
  /** 2xx. Done. */
  | "delivered"
  /** 410 Gone: the host dropped the subscription. The layer has deleted it; do not retry. */
  | "gone"
  /** 413, or the subscription no longer exists: retrying cannot help. */
  | "dropped"
  /** Anything else. The transport should retry. */
  | "retry";

/** The layer's entry point, handed to a delivery transport by {@link EventDelivery.attach}. */
export type DeliveryEndpoints = {
  /**
   * Loads the subscription, signs the envelope with a fresh timestamp, POSTs it, and classifies
   * the response. Call it once per attempt: Standard Webhooks signatures are timestamped, so a
   * retry must be signed again rather than replayed.
   */
  send(job: DeliveryJob): Promise<SendOutcome>;
};

/**
 * Durable delivery transport.
 *
 * The draft spec asks for retries with backoff and a stable event id across them. A queue does
 * exactly that, so `QStashDelivery` enqueues one message per subscription and runs
 * {@link DeliveryEndpoints.send} from its delivery endpoint. `InlineDelivery` sends in-process
 * with no retries, for tests and local development.
 */
export interface EventDelivery {
  /** Accepts the jobs durably (or sends them) before resolving. */
  enqueue(jobs: DeliveryJob[]): Promise<void>;
  /** Receives the layer's entry point, once, when passed to `createEventLayer`. */
  attach?(endpoints: DeliveryEndpoints): void;
  /** The transport's own HTTP endpoint, when it delivers through one. */
  createDeliveryHandler?(): (request: Request) => Promise<Response>;
}
