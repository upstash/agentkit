/**
 * The two seams of the events runtime: a {@link SubscriptionStore} owns the subscriptions, an
 * {@link EventDelivery} gets each signed POST to its callback, with retries.
 */

/** The envelope POSTed to a callback, as the MCP Events draft defines it. */
export type EventEnvelope<TData = unknown> = {
  /** Stable across retries, so the host can drop duplicates. Also sent as `webhook-id`. */
  eventId: string;
  name: string;
  /** ISO-8601. */
  timestamp: string;
  /** Matches the event's `payloadSchema`. */
  data: TData;
  /** Replay cursor. This runtime does not replay, so always `null`. */
  cursor: string | null;
};

/** One webhook subscription, as stored. */
export type Subscription = {
  /** Derived from the owner, callback URL, event name and arguments. */
  id: string;
  event: string;
  /** The validated subscription arguments. */
  args: Record<string, unknown>;
  /** Canonical JSON of {@link args}, which emits are matched on. */
  argsKey: string;
  /** The callback URL the host gave. */
  url: string;
  /** The `whsec_` signing secret, encrypted with the layer's `secretKey`. */
  encryptedSecret: string;
  /** The caller that subscribed. Events only reach subscriptions of the owners they name. */
  owner: string;
  /** ISO-8601. */
  createdAt: string;
  /** Epoch milliseconds. */
  expiresAt: number;
};

/** The fields that locate a subscription in a store's index. */
export type SubscriptionRef = Pick<Subscription, "id" | "event" | "argsKey" | "owner">;

/**
 * Durable storage for subscriptions, indexed by `(event, owner, argsKey)`. The layer computes
 * every key an emit can match, so a store needs no matching logic of its own.
 */
export interface SubscriptionStore {
  /** Creates or replaces a subscription. Must have committed before it resolves. */
  put(subscription: Subscription): Promise<void>;
  /** A live subscription, or `null`. */
  get(id: string): Promise<Subscription | null>;
  /** Removes a subscription and its index entry. A no-op when it does not exist. */
  delete(subscription: SubscriptionRef): Promise<void>;
  /** Every live subscription to `event` owned by one of `owners`, with one of `argsKeys`. */
  find(
    event: string,
    owners: readonly string[],
    argsKeys: readonly string[],
  ): Promise<Subscription[]>;
}

/** One envelope for one subscription. */
export type DeliveryJob = {
  subscriptionId: string;
  envelope: EventEnvelope;
};

/** One POST to a callback, as the layer classifies it. */
export type SendOutcome =
  /** 2xx. */
  | "delivered"
  /** 410: the host dropped the subscription, and the layer deleted it. */
  | "gone"
  /** 413, a redirect, or a subscription that no longer exists: retrying cannot help. */
  | "dropped"
  /** Anything else: retry. */
  | "retry";

/** The layer's entry point, handed to a transport by {@link EventDelivery.attach}. */
export type DeliveryEndpoints = {
  /** Signs the envelope fresh, POSTs it and classifies the answer. Call it once per attempt. */
  send(job: DeliveryJob): Promise<SendOutcome>;
};

export interface EventDelivery {
  /** Accepts the jobs durably (or sends them) before resolving. */
  enqueue(jobs: DeliveryJob[]): Promise<void>;
  /** Receives the layer's entry point when passed to `createEventLayer`. */
  attach?(endpoints: DeliveryEndpoints): void;
  /** The transport's HTTP endpoint, when it delivers through one. */
  createDeliveryHandler?(): (request: Request) => Promise<Response>;
}
