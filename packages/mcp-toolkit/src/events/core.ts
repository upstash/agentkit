/**
 * MCP Events for servers on the official TypeScript SDK.
 *
 * `createEventLayer` gives you typed event definitions, the three `events/*` methods a host calls
 * to subscribe, and an `emit` that fans a payload out to every matching subscription as a signed
 * Standard Webhooks POST. Where subscriptions live and how deliveries are retried are the two
 * seams in `types.ts`; `upstash.ts` fills them with Redis and QStash.
 *
 * The wire format follows the MCP Triggers & Events draft as shipped by ChatGPT: webhook delivery
 * only, a signed verification challenge before the first event, deterministic subscription ids,
 * and expiring subscriptions the host refreshes by subscribing again.
 */
import { createHash, randomBytes } from "node:crypto";
import { ProtocolError, type McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import type { CallerAuth } from "../tasks/core.js";
import type {
  DeliveryJob,
  EventDelivery,
  EventEnvelope,
  SendOutcome,
  SubscriptionStore,
} from "./types.js";
import { SecretBox, callbackUrlProblem, decodeSecret, postSigned } from "./webhooks.js";

/** The draft's cap on a delivered envelope. */
export const MAX_PAYLOAD_BYTES = 256 * 1024;
/** `CallbackEndpointError`: the callback failed verification or could not be reached. */
export const CALLBACK_ENDPOINT_ERROR = -32015;
const INVALID_PARAMS = -32602;

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_TTL_MS = 7 * DAY_MS;
const DEFAULT_MAX_TTL_MS = 30 * DAY_MS;
const DEFAULT_TIMEOUT_MS = 10_000;
/** Matching enumerates subsets of the emitted arguments, so their count is capped. */
const MAX_MATCH_KEYS = 8;

export type { CallerAuth };

export type EventLayerOptions = {
  /** Where subscriptions live. */
  store: SubscriptionStore;
  /** How deliveries get to the callback, with retries. */
  delivery: EventDelivery;
  /**
   * Encrypts the hosts' signing secrets at rest. Any string works; generate one with
   * `openssl rand -base64 32`. Defaults to the `MCP_EVENTS_SECRET_KEY` env var.
   */
  secretKey?: string;
  /**
   * Who is calling, as a stable string — usually your user id. It is part of the subscription id,
   * it is handed to each event's `authorize`, and `emit({ owner })` uses it to deliver only to
   * that caller's subscriptions. Same contract as the tasks layer's `principal`.
   */
  principal?: (auth: CallerAuth | undefined) => string | undefined;
  defaults?: {
    /** Lifetime granted when the host does not ask for one. Defaults to 7 days. */
    ttlMs?: number;
    /** The most the server grants, whatever the host asks. Defaults to 30 days. */
    maxTtlMs?: number;
  };
  /**
   * Accept `http://` and private-network callback URLs. For local development only: it turns
   * off the server-side request forgery checks.
   */
  allowInsecureCallbacks?: boolean;
  /** Timeout for each POST to a callback. Defaults to 10s. */
  timeoutMs?: number;
  /** Override `fetch`, e.g. in tests. */
  fetch?: typeof fetch;
};

/** Subscription arguments are always an object schema, so they can be matched field by field. */
export type EventInputSchema = z.ZodObject;

export type EventConfig<Input extends EventInputSchema, Payload extends z.ZodType> = {
  title?: string;
  /** Tells the model and the user what the event means. */
  description: string;
  /** What a subscriber filters on, e.g. `z.object({ repo: z.string() })`. Defaults to none. */
  input?: Input;
  /** The shape of `data` in every delivery. */
  payload: Payload;
  /**
   * Decides whether a caller may subscribe with these arguments, e.g. whether they can see that
   * repository. Runs on every subscribe and refresh. Leave unset to allow everyone.
   */
  authorize?: (
    args: z.output<Input>,
    caller: { principal?: string; auth?: CallerAuth },
  ) => boolean | Promise<boolean>;
  /**
   * An extra in-process filter, for conditions exact argument matching cannot express — "only
   * comments longer than 100 characters". Runs per subscription on every emit.
   */
  match?: (args: z.output<Input>, payload: z.output<Payload>) => boolean;
};

export type EmitOptions<Args> = {
  /**
   * The values subscriptions are matched on. A subscription matches when every argument it gave
   * equals the value here, so `{ repo: "a", branch: "main" }` reaches subscribers of
   * `{ repo: "a" }`, of `{ repo: "a", branch: "main" }`, and of `{}`.
   *
   * Defaults to the payload fields whose names appear in the input schema.
   */
  args?: Partial<Args>;
  /** Deliver only to subscriptions this principal created. */
  owner?: string;
  /**
   * The event id, stable across retries and sent as `webhook-id`. Pass your own (e.g. the id of
   * the record that changed) so that emitting the same thing twice is deduplicated.
   */
  eventId?: string;
  /** When the event happened. Defaults to now. */
  timestamp?: Date;
};

export type EmitResult = {
  eventId: string;
  /** How many subscriptions the event was handed to. */
  matched: number;
};

export type EventHandle<Input extends EventInputSchema, Payload extends z.ZodType> = {
  readonly name: string;
  /** Validates the payload and delivers it to every matching subscription. */
  emit(payload: z.input<Payload>, options?: EmitOptions<z.output<Input>>): Promise<EmitResult>;
};

/** The descriptor `events/list` returns for each event. */
export type EventDescriptor = {
  name: string;
  title?: string;
  description: string;
  delivery: ["webhook"];
  inputSchema: Record<string, unknown>;
  payloadSchema: Record<string, unknown>;
};

export type EventLayer = {
  /** Declares an event. Call it at module load, so every instance knows every event. */
  define<
    Input extends EventInputSchema = z.ZodObject<Record<string, never>>,
    Payload extends z.ZodType = z.ZodType,
  >(
    name: string,
    config: EventConfig<Input, Payload>,
  ): EventHandle<Input, Payload>;
  /** Declares the `events` capability and serves `events/list`, `events/subscribe`, `events/unsubscribe`. */
  register(server: McpServer): void;
  /** The transport's delivery endpoint, e.g. `export const POST = events.createDeliveryHandler()`. */
  createDeliveryHandler(): (request: Request) => Promise<Response>;
  /** Sends one delivery attempt. Transports call this; exposed for custom ones. */
  send(job: DeliveryJob): Promise<SendOutcome>;
  /** The descriptors `events/list` returns. */
  list(): EventDescriptor[];
  readonly store: SubscriptionStore;
  readonly delivery: EventDelivery;
};

/** Thrown by `emit` when the envelope would exceed the draft's 256 KiB cap. */
export class EventPayloadTooLargeError extends Error {
  override readonly name = "EventPayloadTooLargeError";
  constructor(readonly bytes: number) {
    super(`Event envelope is ${bytes} bytes; the limit is ${MAX_PAYLOAD_BYTES}.`);
  }
}

type Definition = {
  config: EventConfig<EventInputSchema, z.ZodType>;
  input: EventInputSchema;
  descriptor: EventDescriptor;
};

const subscribeParams = z.looseObject({
  name: z.string(),
  arguments: z.record(z.string(), z.unknown()).nullish(),
  delivery: z.looseObject({
    mode: z.string(),
    url: z.string().optional(),
    secret: z.string().optional(),
  }),
  cursor: z.string().nullish(),
  ttlMs: z.number().int().positive().nullish(),
});

const unsubscribeParams = z.looseObject({
  name: z.string(),
  arguments: z.record(z.string(), z.unknown()).nullish(),
  delivery: z.looseObject({ mode: z.string(), url: z.string().optional() }),
});

const listParams = z.looseObject({ cursor: z.string().nullish() });

export function createEventLayer(options: EventLayerOptions): EventLayer {
  const { store, delivery, principal } = options;
  const secretKey = options.secretKey ?? getEnv("MCP_EVENTS_SECRET_KEY");
  if (!secretKey) {
    throw new Error(
      "createEventLayer needs a secretKey (or MCP_EVENTS_SECRET_KEY) to encrypt webhook secrets at rest.",
    );
  }
  const box = new SecretBox(secretKey);
  const ttl = {
    initial: options.defaults?.ttlMs ?? DEFAULT_TTL_MS,
    max: options.defaults?.maxTtlMs ?? DEFAULT_MAX_TTL_MS,
  };
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  /** A secret sealed under a rotated key no longer opens; that just forces a re-verification. */
  const openOrEmpty = (sealed: string): string => {
    try {
      return box.open(sealed);
    } catch {
      return "";
    }
  };
  const definitions = new Map<string, Definition>();

  function define<Input extends EventInputSchema, Payload extends z.ZodType>(
    name: string,
    config: EventConfig<Input, Payload>,
  ): EventHandle<Input, Payload> {
    if (definitions.has(name)) throw new Error(`Event "${name}" is already defined`);
    const input = (config.input ?? z.object({})) as EventInputSchema;
    definitions.set(name, {
      config: config as unknown as EventConfig<EventInputSchema, z.ZodType>,
      input,
      descriptor: {
        name,
        ...(config.title ? { title: config.title } : {}),
        description: config.description,
        delivery: ["webhook"],
        inputSchema: jsonSchema(input, "input"),
        payloadSchema: jsonSchema(config.payload, "output"),
      },
    });
    return {
      name,
      emit: (payload, emitOptions) => emit(name, payload, emitOptions as EmitOptions<unknown>),
    };
  }

  async function emit(
    name: string,
    rawPayload: unknown,
    emitOptions: EmitOptions<unknown> = {},
  ): Promise<EmitResult> {
    const definition = definitions.get(name);
    if (!definition) throw new Error(`Unknown event "${name}"`);
    const payload = definition.config.payload.parse(rawPayload);
    const args = (emitOptions.args ?? pickArgs(definition.input, payload)) as Record<
      string,
      unknown
    >;

    const envelope: EventEnvelope = {
      eventId: emitOptions.eventId ?? `evt_${randomBytes(12).toString("hex")}`,
      name,
      timestamp: (emitOptions.timestamp ?? new Date()).toISOString(),
      data: payload,
      cursor: null,
    };
    const bytes = new TextEncoder().encode(JSON.stringify(envelope)).length;
    if (bytes > MAX_PAYLOAD_BYTES) throw new EventPayloadTooLargeError(bytes);

    const candidates = await store.find(name, matchKeys(args));
    const now = Date.now();
    const targets = candidates.filter(
      (sub) =>
        sub.expiresAt > now &&
        (emitOptions.owner === undefined || String(sub.owner ?? "") === emitOptions.owner) &&
        (!definition.config.match || definition.config.match(sub.args as never, payload as never)),
    );
    if (targets.length > 0) {
      await delivery.enqueue(targets.map((sub) => ({ subscriptionId: sub.id, envelope })));
    }
    return { eventId: envelope.eventId, matched: targets.length };
  }

  async function send(job: DeliveryJob): Promise<SendOutcome> {
    const sub = await store.get(job.subscriptionId);
    if (!sub) return "dropped";
    // Sealed under a key that has since rotated: undeliverable until the host refreshes.
    const secret = openOrEmpty(sub.encryptedSecret);
    if (!secret) return "dropped";
    let response: Response;
    try {
      response = await postSigned({
        url: sub.url,
        secret,
        webhookId: job.envelope.eventId,
        body: JSON.stringify(job.envelope),
        subscriptionId: sub.id,
        timeoutMs,
        fetch: options.fetch,
      });
    } catch {
      return "retry";
    }
    if (response.ok) return "delivered";
    if (response.status === 410) {
      await store.delete(sub.id);
      return "gone";
    }
    if (response.status === 413) return "dropped";
    return "retry";
  }

  async function subscribe(params: z.output<typeof subscribeParams>, ctx: unknown) {
    const definition = definitions.get(params.name);
    if (!definition) throw invalid(`Unknown event "${params.name}"`, "unknown_event");
    if (params.delivery.mode !== "webhook") {
      throw invalid(
        `Delivery mode "${params.delivery.mode}" is not supported`,
        "unsupported_delivery_mode",
      );
    }
    const parsed = definition.input.safeParse(params.arguments ?? {});
    if (!parsed.success) {
      throw invalid(`Invalid arguments: ${parsed.error.message}`, "invalid_arguments");
    }
    const args = parsed.data as Record<string, unknown>;

    const secret = params.delivery.secret;
    if (!secret || !decodeSecret(secret)) {
      throw invalid(
        "delivery.secret must be whsec_ followed by 24-64 base64 bytes",
        "invalid_secret",
      );
    }
    const url = params.delivery.url;
    const problem = callbackUrlProblem(url, options.allowInsecureCallbacks);
    if (problem || !url)
      throw invalid(problem ?? "callback URL is missing", "invalid_callback_url");

    const auth = authOf(ctx);
    const owner = principal?.(auth);
    if (
      definition.config.authorize &&
      !(await definition.config.authorize(args, { principal: owner, auth }))
    ) {
      throw invalid("Not authorized to subscribe with these arguments", "not_authorized");
    }

    const id = subscriptionId(owner, url, params.name, args);
    const existing = await store.get(id);
    // A refresh with the same secret skips the challenge; a new or rotated secret proves the
    // callback again, so a host cannot point someone else's URL at us.
    const verified = existing !== null && openOrEmpty(existing.encryptedSecret) === secret;
    if (!verified) await verifyCallback(url, secret, id);

    const requested =
      params.ttlMs === undefined ? ttl.initial : params.ttlMs === null ? ttl.max : params.ttlMs;
    const granted = Math.min(requested, ttl.max);
    const now = Date.now();
    const expiresAt = now + granted;
    await store.put({
      id,
      event: params.name,
      args,
      argsKey: canonicalJson(args),
      url,
      encryptedSecret: verified && existing ? existing.encryptedSecret : box.seal(secret),
      ...(owner === undefined ? {} : { owner }),
      createdAt: existing?.createdAt ?? new Date(now).toISOString(),
      expiresAt,
    });
    return {
      id,
      refreshBefore: new Date(expiresAt - Math.min(granted / 10, DAY_MS)).toISOString(),
      cursor: null,
      truncated: false,
    };
  }

  async function unsubscribe(params: z.output<typeof unsubscribeParams>, ctx: unknown) {
    const definition = definitions.get(params.name);
    const parsed = definition?.input.safeParse(params.arguments ?? {});
    if (parsed?.success && params.delivery.url) {
      const owner = principal?.(authOf(ctx));
      const args = parsed.data as Record<string, unknown>;
      await store.delete(subscriptionId(owner, params.delivery.url, params.name, args));
    }
    return {};
  }

  async function verifyCallback(url: string, secret: string, id: string): Promise<void> {
    const challenge = randomBytes(24).toString("base64url");
    let response: Response;
    try {
      response = await postSigned({
        url,
        secret,
        webhookId: `msg_verification_${randomBytes(12).toString("hex")}`,
        body: JSON.stringify({ type: "verification", challenge }),
        subscriptionId: id,
        timeoutMs,
        fetch: options.fetch,
      });
    } catch (error) {
      const timedOut =
        error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
      throw callbackError(
        timedOut ? "timeout" : "unreachable",
        "Callback URL could not be reached",
      );
    }
    if (!response.ok) {
      throw callbackError(
        "http_status",
        `Callback answered the challenge with HTTP ${response.status}`,
        { status: response.status },
      );
    }
    const body = (await response.json().catch(() => null)) as { challenge?: unknown } | null;
    if (body?.challenge !== challenge) {
      throw callbackError("challenge_failed", "Callback did not echo the verification challenge");
    }
  }

  function register(server: McpServer): void {
    const low = server.server;
    low.registerCapabilities({ events: {} } as never);
    low.setRequestHandler("events/list", { params: listParams }, async () => ({
      events: [...definitions.values()].map((d) => d.descriptor),
      nextCursor: null,
    }));
    low.setRequestHandler("events/subscribe", { params: subscribeParams }, (params, ctx) =>
      subscribe(params, ctx),
    );
    low.setRequestHandler("events/unsubscribe", { params: unsubscribeParams }, (params, ctx) =>
      unsubscribe(params, ctx),
    );
  }

  function createDeliveryHandler(): (request: Request) => Promise<Response> {
    if (!delivery.createDeliveryHandler) {
      throw new Error(
        "This delivery sends in-process and has no endpoint to serve. Use QStashDelivery to expose one.",
      );
    }
    return delivery.createDeliveryHandler();
  }

  delivery.attach?.({ send });

  return {
    define,
    register,
    createDeliveryHandler,
    send,
    list: () => [...definitions.values()].map((d) => d.descriptor),
    store,
    delivery,
  };
}

/** JSON with object keys sorted at every level, so equal values serialize identically. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .filter((key) => record[key] !== undefined)
        .map((key) => [key, sortKeys(record[key])]),
    );
  }
  return value;
}

/** Every `argsKey` an emit with these arguments matches: one per subset, including `{}`. */
export function matchKeys(args: Record<string, unknown>): string[] {
  const entries = Object.entries(args).filter(([, value]) => value !== undefined);
  if (entries.length > MAX_MATCH_KEYS) {
    throw new Error(
      `An emit can match on at most ${MAX_MATCH_KEYS} arguments, got ${entries.length}`,
    );
  }
  const keys: string[] = [];
  for (let mask = 0; mask < 1 << entries.length; mask++) {
    keys.push(canonicalJson(Object.fromEntries(entries.filter((_, i) => mask & (1 << i)))));
  }
  return keys;
}

/** Deterministic, as the draft asks: same owner, callback, event and arguments → same id. */
export function subscriptionId(
  owner: string | undefined,
  url: string,
  event: string,
  args: Record<string, unknown>,
): string {
  const digest = createHash("sha256")
    .update(canonicalJson([owner ?? null, url, event, args]))
    .digest("hex");
  return `sub_${digest.slice(0, 32)}`;
}

function pickArgs(input: EventInputSchema, payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== "object") return {};
  const picked: Record<string, unknown> = {};
  for (const key of Object.keys(input.shape)) {
    const value = (payload as Record<string, unknown>)[key];
    if (value !== undefined) picked[key] = value;
  }
  return picked;
}

function jsonSchema(schema: z.ZodType, io: "input" | "output"): Record<string, unknown> {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(schema, { io }) as Record<string, unknown>;
  return rest;
}

function authOf(ctx: unknown): CallerAuth | undefined {
  return (ctx as { http?: { authInfo?: CallerAuth } } | undefined)?.http?.authInfo;
}

function invalid(message: string, reason: string): ProtocolError {
  return new ProtocolError(INVALID_PARAMS, message, { reason });
}

function callbackError(
  reason: string,
  message: string,
  extra: Record<string, unknown> = {},
): ProtocolError {
  return new ProtocolError(CALLBACK_ENDPOINT_ERROR, message, { reason, ...extra });
}

function getEnv(name: string): string | undefined {
  return typeof process === "object" ? process.env?.[name] : undefined;
}
