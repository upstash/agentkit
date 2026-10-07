/**
 * Single-process backends, for tests and for a first local run.
 *
 * {@link MemorySubscriptionStore} forgets every subscription on restart, and {@link InlineDelivery}
 * POSTs from the process that called `emit`, once, with no retries. Use the Upstash backends when
 * a host has to be able to rely on the deliveries.
 */
import type {
  DeliveryEndpoints,
  DeliveryJob,
  EventDelivery,
  SendOutcome,
  Subscription,
  SubscriptionStore,
} from "../types.js";

/** An in-process {@link SubscriptionStore}. Not durable, not shared between instances. */
export class MemorySubscriptionStore implements SubscriptionStore {
  private readonly subscriptions = new Map<string, Subscription>();

  async put(subscription: Subscription): Promise<void> {
    this.subscriptions.set(subscription.id, { ...subscription });
  }

  async get(id: string): Promise<Subscription | null> {
    const subscription = this.subscriptions.get(id);
    if (!subscription) return null;
    if (subscription.expiresAt <= Date.now()) {
      this.subscriptions.delete(id);
      return null;
    }
    return { ...subscription };
  }

  async delete(id: string): Promise<void> {
    this.subscriptions.delete(id);
  }

  async find(event: string, argsKeys: string[]): Promise<Subscription[]> {
    const keys = new Set(argsKeys);
    const now = Date.now();
    return [...this.subscriptions.values()]
      .filter((sub) => sub.event === event && keys.has(sub.argsKey) && sub.expiresAt > now)
      .map((sub) => ({ ...sub }));
  }
}

/**
 * Sends each delivery from the calling process, once. `emit` resolves after every POST has been
 * answered. A failed delivery is reported to `onOutcome` and then forgotten.
 */
export class InlineDelivery implements EventDelivery {
  private endpoints: DeliveryEndpoints | undefined;

  constructor(
    private readonly options: { onOutcome?: (job: DeliveryJob, outcome: SendOutcome) => void } = {},
  ) {}

  attach(endpoints: DeliveryEndpoints): void {
    this.endpoints = endpoints;
  }

  async enqueue(jobs: DeliveryJob[]): Promise<void> {
    const endpoints = this.endpoints;
    if (!endpoints)
      throw new Error("InlineDelivery is not attached — pass it to createEventLayer().");
    await Promise.all(
      jobs.map(async (job) => {
        const outcome = await endpoints.send(job);
        this.options.onOutcome?.(job, outcome);
      }),
    );
  }
}
