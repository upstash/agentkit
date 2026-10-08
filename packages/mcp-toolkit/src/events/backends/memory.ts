/**
 * Single-process backends for tests and a first local run. {@link InlineDelivery} POSTs once,
 * from the process that called `emit`, with no retries.
 */
import type {
  DeliveryEndpoints,
  DeliveryJob,
  EventDelivery,
  SendOutcome,
  Subscription,
  SubscriptionRef,
  SubscriptionStore,
} from "../types.js";

/** An in-process {@link SubscriptionStore}. Not durable, not shared between instances. */
export class MemorySubscriptionStore implements SubscriptionStore {
  private readonly subscriptions = new Map<string, Subscription>();

  async put(subscription: Subscription): Promise<void> {
    this.subscriptions.set(subscription.id, { ...subscription });
  }

  async get(id: string): Promise<Subscription | null> {
    const subscription = this.live(id);
    return subscription ? { ...subscription } : null;
  }

  async delete({ id }: SubscriptionRef): Promise<void> {
    this.subscriptions.delete(id);
  }

  async find(
    event: string,
    owners: readonly string[],
    argsKeys: readonly string[],
  ): Promise<Subscription[]> {
    const ownerSet = new Set(owners);
    const keys = new Set(argsKeys);
    return [...this.subscriptions.keys()]
      .map((id) => this.live(id))
      .filter(
        (sub): sub is Subscription =>
          sub !== undefined &&
          sub.event === event &&
          ownerSet.has(sub.owner) &&
          keys.has(sub.argsKey),
      )
      .map((sub) => ({ ...sub }));
  }

  /** Stands in for Redis' expiry. */
  private live(id: string): Subscription | undefined {
    const subscription = this.subscriptions.get(id);
    if (subscription && subscription.expiresAt <= Date.now()) {
      this.subscriptions.delete(id);
      return undefined;
    }
    return subscription;
  }
}

/** Sends each delivery from the calling process, once. A failure goes to `onOutcome`, then is forgotten. */
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
    if (!endpoints) {
      throw new Error("InlineDelivery is not attached — pass it to createEventLayer().");
    }
    await Promise.all(
      jobs.map(async (job) => {
        const outcome = await endpoints.send(job);
        this.options.onOutcome?.(job, outcome);
      }),
    );
  }
}
