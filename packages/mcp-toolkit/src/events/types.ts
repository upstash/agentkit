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
  /** Derived from the subscriber, callback URL, event name and arguments. */
  id: string;
  event: string;
  /** The validated subscription arguments: an event matches when its payload has these values. */
  args: Record<string, unknown>;
  /** The callback URL the host gave. */
  url: string;
  /** The `whsec_` signing secret, encrypted with the layer's `secretKey`. */
  encryptedSecret: string;
  /** Who subscribed: the id `principal` returned. */
  subscriber: string;
  /** ISO-8601. */
  createdAt: string;
  /** Epoch milliseconds. */
  expiresAt: number;
};

/** Durable storage for subscriptions. The layer does the matching, so a store only indexes by event. */
export interface SubscriptionStore {
  /** Creates or replaces a subscription. Must have committed before it resolves. */
  put(subscription: Subscription): Promise<void>;
  /** A live subscription, or `null`. */
  get(id: string): Promise<Subscription | null>;
  /** Removes a subscription. A no-op when it does not exist. */
  delete(subscription: Pick<Subscription, "id" | "event">): Promise<void>;
  /** Every live subscription to `event`. */
  find(event: string): Promise<Subscription[]>;
}

/** One envelope for one subscription. */
export type DeliveryJob = {
  subscriptionId: string;
  envelope: EventEnvelope;
};

/**
 * Re-checks `authorize`, signs the envelope fresh and POSTs it. Resolves `true` when the job is
 * finished (delivered, or retrying cannot help) and `false` when the transport should retry.
 */
export type SendJob = (job: DeliveryJob) => Promise<boolean>;

export interface EventDelivery {
  /** Accepts the jobs durably before resolving. */
  enqueue(jobs: DeliveryJob[]): Promise<void>;
  /** The HTTP endpoint the transport delivers each job to. */
  createDeliveryHandler(send: SendJob): (request: Request) => Promise<Response>;
}
