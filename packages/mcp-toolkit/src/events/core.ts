/**
 * MCP Events for servers on the official TypeScript SDK: typed event definitions, the three
 * `events/*` methods a host calls, and an `emit` that delivers signed Standard Webhooks POSTs to
 * the matching subscriptions `authorize` allows. Webhook delivery only, as ChatGPT ships it.
 */
import { ProtocolError, type AuthInfo, type McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import {
  callerOf,
  requirePrincipal,
  resolvePrincipal,
  type PrincipalResolver,
} from "../shared/auth.js";
import { env } from "../shared/env.js";
import { randomBase64Url, randomHex, sha256Hex } from "../shared/crypto.js";
import type { DeliveryJob, EventDelivery, EventEnvelope, SubscriptionStore } from "./types.js";
import { SecretBox, callbackUrlProblem, decodeSecret, postSigned, readCapped } from "./webhooks.js";

/** The draft's cap on a delivered envelope. */
const MAX_PAYLOAD_BYTES = 256 * 1024;
/** `CallbackEndpointError`: the callback failed verification. */
const CALLBACK_ENDPOINT_ERROR = -32015;
const INVALID_PARAMS = -32602;

const DAY_MS = 24 * 60 * 60 * 1000;
/** Lifetime granted when the host does not ask for one. */
const DEFAULT_TTL_MS = 7 * DAY_MS;
/** The most a subscription is granted. */
const MAX_TTL_MS = 30 * DAY_MS;
/** The challenge echo is tiny; never read more than this from a callback. */
const MAX_CHALLENGE_RESPONSE_BYTES = 4096;

export type EventLayerOptions = {
  store: SubscriptionStore;
  delivery: EventDelivery;
  /**
   * Who is calling, usually your user id from `auth`. Required, and it must return an id: throw
   * when it can't, and the subscribe is refused as not authenticated.
   */
  principal: PrincipalResolver;
  /**
   * Encrypts the hosts' signing secrets at rest. Defaults to `MCP_EVENTS_SECRET_KEY`; one of the
   * two is required. Generate one with `openssl rand -base64 32`.
   */
  secretKey?: string;
  /** Accept `http://` and private callback URLs. Local development only: it disables the SSRF checks. */
  allowInsecureCallbacks?: boolean;
};

/** Subscription arguments are an object schema, so they can be matched field by field. */
export type EventInputSchema = z.ZodObject;

/** What `authorize` is told about the subscriber. */
export type AuthorizeCaller = {
  /** The subscriber's id, from `principal`. */
  principal: string;
  /** `"subscribe"` on every subscribe and refresh, `"deliver"` before every delivery. */
  phase: "subscribe" | "deliver";
  /** Only at subscribe time: no request stands behind a delivery, and the token is never stored. */
  auth?: AuthInfo;
  /** Only at subscribe time. */
  request?: Request;
};

export type EventConfig<Input extends EventInputSchema, Payload extends z.ZodType> = {
  title?: string;
  /** What the event means, for the model and the user. */
  description: string;
  /**
   * What a subscriber filters on, e.g. `z.object({ repo: z.string() })`. Every field must also be
   * a payload field: an emit is routed by the payload's values. Defaults to none.
   */
  input?: Input;
  /** The shape of `data` in every delivery. */
  payload: Payload;
  /**
   * Whether this subscriber may see events with these values, e.g. whether they can read that
   * repo. Required. On subscribe it gets the subscription's arguments; before every delivery it
   * gets the event's own values for the input fields, so a subscriber without a filter is still
   * checked against what each event is about, and revoked access stops the events. Pass
   * `() => true` for an event any authenticated caller may hear.
   */
  authorize: (
    args: Partial<z.output<Input>>,
    caller: AuthorizeCaller,
  ) => boolean | Promise<boolean>;
};

export type EventHandle<Payload extends z.ZodType> = {
  readonly name: string;
  /**
   * Validates the payload and hands it to every subscription whose arguments match the payload's
   * values. `authorize` is checked again before each delivery. Reuse an `eventId` (sent as
   * `webhook-id`) to deduplicate an emit.
   */
  emit(payload: z.input<Payload>, options?: { eventId?: string }): Promise<{ eventId: string }>;
};

export type EventLayer = {
  /** Declares an event. Call it at module scope, so every instance knows every event. */
  define<
    Input extends EventInputSchema = z.ZodObject<Record<string, never>>,
    Payload extends z.ZodType = z.ZodType,
  >(
    name: string,
    config: EventConfig<Input, Payload>,
  ): EventHandle<Payload>;
  /** Declares the `events` capability and serves `events/list`, `/subscribe` and `/unsubscribe`. */
  register(server: McpServer): void;
  /** The transport's delivery endpoint: `export const POST = events.createDeliveryHandler()`. */
  createDeliveryHandler(): (request: Request) => Promise<Response>;
};

type Definition = {
  config: EventConfig<EventInputSchema, z.ZodType>;
  input: EventInputSchema;
  /** What `events/list` returns for this event. */
  descriptor: Record<string, unknown>;
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
  const { store, delivery } = options;
  const principal = requirePrincipal(options.principal, "createEventLayer");
  const definitions = new Map<string, Definition>();

  // Resolved on first use, because layers are built at module scope during framework builds.
  // There is no default key: a missing one fails the first subscribe or delivery.
  let box: SecretBox | undefined;
  const secretBox = (): SecretBox => {
    if (box) return box;
    const secretKey = options.secretKey ?? env("MCP_EVENTS_SECRET_KEY");
    if (!secretKey) {
      throw new Error(
        "createEventLayer needs a secretKey (or MCP_EVENTS_SECRET_KEY) to encrypt webhook secrets at rest. Generate one with: openssl rand -base64 32",
      );
    }
    return (box = new SecretBox(secretKey));
  };

  function define<Input extends EventInputSchema, Payload extends z.ZodType>(
    name: string,
    config: EventConfig<Input, Payload>,
  ): EventHandle<Payload> {
    if (definitions.has(name)) throw new Error(`Event "${name}" is already defined`);
    if (typeof config.authorize !== "function") {
      throw new Error(
        `Event "${name}" needs \`authorize\`: who may subscribe and receive it. Pass \`() => true\` for an event any authenticated caller may hear.`,
      );
    }
    const input = (config.input ?? z.object({})) as EventInputSchema;
    const payloadFields = config.payload instanceof z.ZodObject ? config.payload.shape : {};
    const missing = Object.keys(input.shape).filter((key) => !(key in payloadFields));
    if (missing.length > 0) {
      throw new Error(
        `Event "${name}": input field(s) ${missing.join(", ")} must also be payload fields, because an emit is routed by the payload's values.`,
      );
    }
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
    return { name, emit: (payload, emitOptions) => emit(name, payload, emitOptions?.eventId) };
  }

  async function emit(
    name: string,
    rawPayload: unknown,
    eventId = `evt_${randomHex(12)}`,
  ): Promise<{ eventId: string }> {
    const definition = definitions.get(name);
    if (!definition) throw new Error(`Unknown event "${name}"`);
    const payload = definition.config.payload.parse(rawPayload);
    const envelope: EventEnvelope = {
      eventId,
      name,
      timestamp: new Date().toISOString(),
      data: payload,
      cursor: null,
    };
    const bytes = new TextEncoder().encode(JSON.stringify(envelope)).length;
    if (bytes > MAX_PAYLOAD_BYTES) {
      throw new Error(`Event envelope is ${bytes} bytes; the limit is ${MAX_PAYLOAD_BYTES}.`);
    }
    const values = valuesOf(definition.input, payload);
    const targets = (await store.find(name)).filter((sub) => matches(sub.args, values));
    if (targets.length > 0) {
      await delivery.enqueue(targets.map((sub) => ({ subscriptionId: sub.id, envelope })));
    }
    return { eventId };
  }

  async function send(job: DeliveryJob): Promise<boolean> {
    const sub = await store.get(job.subscriptionId);
    const definition = sub && definitions.get(sub.event);
    if (!sub || !definition) return true;
    // Access can be revoked after subscribing, so ask again before every delivery, about this
    // event's own values rather than the subscription's (possibly empty) filter.
    let allowed: boolean;
    try {
      allowed = await definition.config.authorize(
        valuesOf(definition.input, job.envelope.data) as never,
        { principal: sub.subscriber, phase: "deliver" },
      );
    } catch {
      return false;
    }
    if (!allowed) return true;
    const secret = await secretBox().open(sub.encryptedSecret);
    if (!secret) return true; // sealed under a rotated key: wait for the host's refresh
    let response: Response;
    try {
      response = await postSigned({
        url: sub.url,
        secret,
        webhookId: job.envelope.eventId,
        body: JSON.stringify(job.envelope),
        subscriptionId: sub.id,
      });
    } catch {
      return false;
    }
    // Release the connection: the body is never needed.
    await response.body?.cancel().catch(() => undefined);
    if (response.status === 410) await store.delete(sub); // the host dropped the subscription
    // A 413 or a redirect (never followed) would fail the same way again; anything else retries.
    return (
      response.ok ||
      response.status === 410 ||
      response.status === 413 ||
      (response.status >= 300 && response.status < 400)
    );
  }

  async function subscribe(params: z.output<typeof subscribeParams>, ctx: unknown) {
    const caller = callerOf(ctx);
    const subscriber = await resolvePrincipal(principal, caller);
    if (!subscriber) throw notAuthenticated();

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
    if (!decodeSecret(secret)) {
      throw invalid(
        "delivery.secret must be whsec_ followed by 24-64 base64 bytes",
        "invalid_secret",
      );
    }
    const url = params.delivery.url;
    const problem = callbackUrlProblem(url, options.allowInsecureCallbacks);
    if (problem || !url || !secret) {
      throw invalid(problem ?? "callback URL is missing", "invalid_callback_url");
    }

    const allowed = await definition.config.authorize(args, {
      principal: subscriber,
      phase: "subscribe",
      auth: caller.auth,
      request: caller.request,
    });
    if (!allowed) {
      throw invalid("Not authorized to subscribe with these arguments", "not_authorized");
    }

    const id = await subscriptionId(subscriber, url, params.name, args);
    const existing = await store.get(id);
    // A refresh with the same secret skips the challenge; a new secret proves the callback again.
    const verified =
      existing !== null && (await secretBox().open(existing.encryptedSecret)) === secret;
    if (!verified) await verifyCallback(url, secret, id);

    const requested = params.ttlMs === undefined ? DEFAULT_TTL_MS : (params.ttlMs ?? MAX_TTL_MS);
    const granted = Math.min(requested, MAX_TTL_MS);
    const now = Date.now();
    const expiresAt = now + granted;
    await store.put({
      id,
      event: params.name,
      args,
      url,
      encryptedSecret: verified ? existing.encryptedSecret : await secretBox().seal(secret),
      subscriber,
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
    const subscriber = await resolvePrincipal(principal, callerOf(ctx));
    if (!subscriber) throw notAuthenticated();
    const parsed = definitions.get(params.name)?.input.safeParse(params.arguments ?? {});
    if (parsed?.success && params.delivery.url) {
      // The id includes the caller, so a caller can only ever remove their own subscription.
      const args = parsed.data as Record<string, unknown>;
      const id = await subscriptionId(subscriber, params.delivery.url, params.name, args);
      await store.delete({ id, event: params.name });
    }
    return {};
  }

  /**
   * Posts a signed challenge and expects it echoed back. Every failure gives the caller the same
   * error: telling apart a timeout, a refused port and a status would let them map the network
   * behind this server. The detail goes to the server log instead.
   */
  async function verifyCallback(url: string, secret: string, id: string): Promise<void> {
    const challenge = randomBase64Url(24);
    let detail: string | undefined;
    try {
      const response = await postSigned({
        url,
        secret,
        webhookId: `msg_verification_${randomHex(12)}`,
        body: JSON.stringify({ type: "verification", challenge }),
        subscriptionId: id,
      });
      const text = await readCapped(response, MAX_CHALLENGE_RESPONSE_BYTES);
      if (!response.ok) detail = `HTTP ${response.status}`;
      else if (echoedChallenge(text) !== challenge) detail = "challenge not echoed";
    } catch (error) {
      detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    }
    if (detail !== undefined) {
      console.warn(`[mcp-toolkit] callback verification failed for ${url}: ${detail}`);
      throw new ProtocolError(CALLBACK_ENDPOINT_ERROR, "Callback URL failed verification");
    }
  }

  function register(server: McpServer): void {
    const low = server.server;
    low.registerCapabilities({ events: {} } as never);
    low.setRequestHandler("events/list", { params: listParams }, async () => ({
      events: [...definitions.values()].map((d) => d.descriptor),
      nextCursor: null,
    }));
    low.setRequestHandler("events/subscribe", { params: subscribeParams }, subscribe);
    low.setRequestHandler("events/unsubscribe", { params: unsubscribeParams }, unsubscribe);
  }

  return { define, register, createDeliveryHandler: () => delivery.createDeliveryHandler(send) };
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

/** Deterministic, as the draft asks: same subscriber, callback, event and arguments give the same id. */
export async function subscriptionId(
  subscriber: string,
  url: string,
  event: string,
  args: Record<string, unknown>,
): Promise<string> {
  return `sub_${(await sha256Hex(canonicalJson([subscriber, url, event, args]))).slice(0, 32)}`;
}

/** The payload's values for the event's input fields: what an emit is routed and authorized by. */
function valuesOf(input: EventInputSchema, payload: unknown): Record<string, unknown> {
  const record = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  return Object.fromEntries(
    Object.keys(input.shape)
      .filter((key) => record[key] !== undefined)
      .map((key) => [key, record[key]]),
  );
}

/** A subscription matches when the event has every value it filtered on. */
function matches(filter: Record<string, unknown>, values: Record<string, unknown>): boolean {
  return Object.entries(filter).every(
    ([key, value]) => key in values && canonicalJson(values[key]) === canonicalJson(value),
  );
}

function echoedChallenge(text: string): unknown {
  try {
    return (JSON.parse(text) as { challenge?: unknown } | null)?.challenge;
  } catch {
    return undefined;
  }
}

function jsonSchema(schema: z.ZodType, io: "input" | "output"): Record<string, unknown> {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(schema, { io }) as Record<string, unknown>;
  return rest;
}

function invalid(message: string, reason: string): ProtocolError {
  return new ProtocolError(INVALID_PARAMS, message, { reason });
}

function notAuthenticated(): ProtocolError {
  return invalid(
    "Not authenticated: this server could not identify the caller",
    "not_authenticated",
  );
}
