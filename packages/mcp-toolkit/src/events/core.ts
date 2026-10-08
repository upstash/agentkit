/**
 * MCP Events for servers on the official TypeScript SDK: typed event definitions, the three
 * `events/*` methods a host calls, and an `emit` that delivers signed Standard Webhooks POSTs to
 * the matching subscriptions `authorize` allows. Webhook delivery only, as ChatGPT ships it.
 */
import { ProtocolError, type McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import {
  callerOf,
  requirePrincipal,
  resolvePrincipal,
  type Caller,
  type CallerAuth,
  type Principal,
  type PrincipalResolver,
} from "../shared/auth.js";
import { randomBase64Url, randomHex, sha256Hex } from "../shared/crypto.js";
import type {
  DeliveryJob,
  EventDelivery,
  EventEnvelope,
  SendOutcome,
  SubscriptionStore,
} from "./types.js";
import { SecretBox, callbackUrlProblem, decodeSecret, postSigned, readCapped } from "./webhooks.js";

/** The draft's cap on a delivered envelope. */
export const MAX_PAYLOAD_BYTES = 256 * 1024;
/** `CallbackEndpointError`: the callback failed verification. */
export const CALLBACK_ENDPOINT_ERROR = -32015;
const INVALID_PARAMS = -32602;

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_TTL_MS = 7 * DAY_MS;
const DEFAULT_MAX_TTL_MS = 30 * DAY_MS;
const DEFAULT_TIMEOUT_MS = 10_000;
/** Matching enumerates subsets of the emitted arguments, so their count is capped. */
const MAX_MATCH_KEYS = 8;
/** The challenge echo is tiny; never read more than this from a callback. */
const MAX_CHALLENGE_RESPONSE_BYTES = 4096;

export type { Caller, CallerAuth, Principal };

export type EventLayerOptions = {
  store: SubscriptionStore;
  delivery: EventDelivery;
  /**
   * Encrypts the hosts' signing secrets at rest. Defaults to `MCP_EVENTS_SECRET_KEY`; one of the
   * two is required. Generate one with `openssl rand -base64 32`.
   */
  secretKey?: string;
  /**
   * Who is calling, usually your user id from `auth`. Required, and it must return an id: throw
   * when it can't, and the subscribe is refused as not authenticated. Return `{ id, context }` to store non-secret context (an
   * org id) that `authorize` gets back before each delivery. Never put the token in it.
   */
  principal: PrincipalResolver;
  defaults?: {
    /** Lifetime granted when the host does not ask for one. Defaults to 7 days. */
    ttlMs?: number;
    /** The most the server grants. Defaults to 30 days. */
    maxTtlMs?: number;
  };
  /** Accept `http://` and private callback URLs. Local development only: it disables the SSRF checks. */
  allowInsecureCallbacks?: boolean;
  /** Timeout for each POST to a callback. Defaults to 10s. */
  timeoutMs?: number;
  /** Override `fetch`, e.g. in tests. */
  fetch?: typeof fetch;
};

/** Subscription arguments are an object schema, so they can be matched field by field. */
export type EventInputSchema = z.ZodObject;

/** What `authorize` is told about the subscriber. */
export type AuthorizeCaller = {
  /** The subscriber's id, from `principal`. */
  principal: string;
  /** The context `principal` returned at subscribe time, or `{}`. */
  context: Record<string, unknown>;
  /** `"subscribe"` on every subscribe and refresh, `"deliver"` before every delivery. */
  phase: "subscribe" | "deliver";
  /** Only at subscribe time: no request stands behind a delivery, and the token is never stored. */
  auth?: CallerAuth;
  /** Only at subscribe time. */
  request?: Request;
};

export type EventConfig<
  Input extends EventInputSchema,
  Payload extends z.ZodType,
  Personal extends boolean = false,
> = {
  title?: string;
  /** What the event means, for the model and the user. */
  description: string;
  /** What a subscriber filters on, e.g. `z.object({ repo: z.string() })`. Defaults to none. */
  input?: Input;
  /** The shape of `data` in every delivery. */
  payload: Payload;
  /**
   * Whether this subscriber may subscribe with these arguments and receive what they match, e.g.
   * whether they can read that document. Required. Runs on every subscribe and refresh, and again
   * before every delivery, so revoked access stops the events. Pass `() => true` for an event any
   * authenticated caller may hear.
   */
  authorize: (args: z.output<Input>, caller: AuthorizeCaller) => boolean | Promise<boolean>;
  /**
   * A personal event belongs to specific users ("your export finished"), so every `emit` must say
   * who with `to`. The type makes `to` required, and so does a runtime check.
   */
  personal?: Personal;
  /** An extra filter for what exact argument matching cannot express. Runs per subscription. */
  match?: (args: z.output<Input>, payload: z.output<Payload>) => boolean;
};

/** One user id, or several. */
export type Recipients = string | readonly string[];

/**
 * `args` is optional when every input field is also a payload field (the match values are read
 * from the payload), and required otherwise, so a filter can never silently match nothing.
 */
type ArgsOption<Input, Payload> = string extends keyof Input
  ? { args?: Partial<Input> } // no input schema: nothing to match on
  : [Exclude<keyof Input, keyof Payload>] extends [never]
    ? { args?: Partial<Input> }
    : { args: Input };

type ToOption<Personal extends boolean> = Personal extends true
  ? { to: Recipients }
  : { to?: Recipients };

export type EmitOptions<Input, Payload, Personal extends boolean = false> = ArgsOption<
  Input,
  Payload
> &
  ToOption<Personal> & {
    /** Stable across retries and sent as `webhook-id`. Reuse an id to deduplicate an emit. */
    eventId?: string;
    /** Defaults to now. */
    timestamp?: Date;
  };

/** The options argument may be left out when none of its fields are required. */
type OptionsArg<T> = Partial<T> extends T ? [options?: T] : [options: T];

type AnyEmitOptions = {
  args?: Record<string, unknown>;
  to?: Recipients;
  eventId?: string;
  timestamp?: Date;
};

export type EmitResult = {
  eventId: string;
  /** How many subscriptions the event was handed to. */
  matched: number;
};

export type EventHandle<
  Input extends EventInputSchema,
  Payload extends z.ZodType,
  Personal extends boolean = false,
> = {
  readonly name: string;
  /**
   * Validates the payload and hands it to every matching subscription, or only those of the users
   * in `to`. `authorize` is checked again before each delivery.
   */
  emit(
    payload: z.input<Payload>,
    ...options: OptionsArg<EmitOptions<z.output<Input>, z.output<Payload>, Personal>>
  ): Promise<EmitResult>;
};

/** What `events/list` returns for each event. */
export type EventDescriptor = {
  name: string;
  title?: string;
  description: string;
  delivery: ["webhook"];
  inputSchema: Record<string, unknown>;
  payloadSchema: Record<string, unknown>;
};

export type EventLayer = {
  /** Declares an event. Call it at module scope, so every instance knows every event. */
  define<
    Input extends EventInputSchema = z.ZodObject<Record<string, never>>,
    Payload extends z.ZodType = z.ZodType,
    Personal extends boolean = false,
  >(
    name: string,
    config: EventConfig<Input, Payload, Personal>,
  ): EventHandle<Input, Payload, Personal>;
  /** Declares the `events` capability and serves `events/list`, `/subscribe` and `/unsubscribe`. */
  register(server: McpServer): void;
  /** The transport's delivery endpoint: `export const POST = events.createDeliveryHandler()`. */
  createDeliveryHandler(): (request: Request) => Promise<Response>;
  /** The descriptors `events/list` returns. */
  list(): EventDescriptor[];
};

/** Thrown by `emit` when the envelope would exceed the draft's 256 KiB cap. */
export class EventPayloadTooLargeError extends Error {
  override readonly name = "EventPayloadTooLargeError";
  constructor(readonly bytes: number) {
    super(`Event envelope is ${bytes} bytes; the limit is ${MAX_PAYLOAD_BYTES}.`);
  }
}

type Definition = {
  config: EventConfig<EventInputSchema, z.ZodType, boolean>;
  input: EventInputSchema;
  /** Input fields a subscriber must give, so an emit must have a value for them. */
  required: string[];
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
  const { store, delivery } = options;
  const principal = requirePrincipal(options.principal, "createEventLayer");
  // Resolved on first use, because layers are built at module scope during framework builds.
  // There is no default key: a missing one fails the first subscribe or delivery.
  let box: SecretBox | undefined;
  const secretBox = (): SecretBox => {
    if (box) return box;
    const secretKey = options.secretKey ?? getEnv("MCP_EVENTS_SECRET_KEY");
    if (!secretKey) {
      throw new Error(
        "createEventLayer needs a secretKey (or MCP_EVENTS_SECRET_KEY) to encrypt webhook secrets at rest. Generate one with: openssl rand -base64 32",
      );
    }
    return (box = new SecretBox(secretKey));
  };
  /** A secret sealed under a rotated key no longer opens, which forces a re-verification. */
  const openOrEmpty = async (sealed: string): Promise<string> => {
    const opener = secretBox(); // a missing key throws here, outside the catch
    try {
      return await opener.open(sealed);
    } catch {
      return "";
    }
  };
  const ttl = {
    initial: options.defaults?.ttlMs ?? DEFAULT_TTL_MS,
    max: options.defaults?.maxTtlMs ?? DEFAULT_MAX_TTL_MS,
  };
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const definitions = new Map<string, Definition>();

  function define<
    Input extends EventInputSchema,
    Payload extends z.ZodType,
    Personal extends boolean = false,
  >(
    name: string,
    config: EventConfig<Input, Payload, Personal>,
  ): EventHandle<Input, Payload, Personal> {
    if (definitions.has(name)) throw new Error(`Event "${name}" is already defined`);
    if (typeof config.authorize !== "function") {
      throw new Error(
        `Event "${name}" needs \`authorize\`: who may subscribe and receive it. Pass \`() => true\` for an event any authenticated caller may hear.`,
      );
    }
    const input = (config.input ?? z.object({})) as EventInputSchema;
    definitions.set(name, {
      config: config as unknown as EventConfig<EventInputSchema, z.ZodType, boolean>,
      input,
      required: Object.entries(input.shape)
        .filter(([, field]) => !(field as z.ZodType).safeParse(undefined).success)
        .map(([key]) => key),
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
      emit: (payload, ...rest) => emit(name, payload, rest[0] as AnyEmitOptions | undefined),
    };
  }

  async function emit(
    name: string,
    rawPayload: unknown,
    emitOptions: AnyEmitOptions = {},
  ): Promise<EmitResult> {
    const definition = definitions.get(name);
    if (!definition) throw new Error(`Unknown event "${name}"`);
    const to = emitOptions.to;
    const recipients = to === undefined ? undefined : new Set(typeof to === "string" ? [to] : to);
    if (definition.config.personal && !recipients) {
      throw new Error(`"${name}" is a personal event: emit it with \`to\`.`);
    }
    const payload = definition.config.payload.parse(rawPayload);
    const args = (emitOptions.args ?? pickArgs(definition.input, payload)) as Record<
      string,
      unknown
    >;
    for (const key of definition.required) {
      // Every subscriber filtered on it, so without a value the event could match nobody.
      if (args[key] === undefined) {
        throw new Error(
          `emit("${name}") has no value for "${key}": put it in the payload or in \`args\`.`,
        );
      }
    }
    const envelope: EventEnvelope = {
      eventId: emitOptions.eventId ?? `evt_${randomHex(12)}`,
      name,
      timestamp: (emitOptions.timestamp ?? new Date()).toISOString(),
      data: payload,
      cursor: null,
    };
    const bytes = new TextEncoder().encode(JSON.stringify(envelope)).length;
    if (bytes > MAX_PAYLOAD_BYTES) throw new EventPayloadTooLargeError(bytes);
    if (recipients?.size === 0) return { eventId: envelope.eventId, matched: 0 };

    const match = definition.config.match;
    const targets = (await store.find(name, matchKeys(args))).filter(
      (sub) =>
        (!recipients || recipients.has(sub.subscriber)) &&
        (!match || match(sub.args as never, payload as never)),
    );
    if (targets.length > 0) {
      await delivery.enqueue(targets.map((sub) => ({ subscriptionId: sub.id, envelope })));
    }
    return { eventId: envelope.eventId, matched: targets.length };
  }

  async function send(job: DeliveryJob): Promise<SendOutcome> {
    const sub = await store.get(job.subscriptionId);
    const definition = sub && definitions.get(sub.event);
    if (!sub || !definition) return "dropped";
    // Access can be revoked after subscribing, so ask again before every delivery.
    let allowed: boolean;
    try {
      allowed = await definition.config.authorize(sub.args as never, {
        principal: sub.subscriber,
        context: sub.context ?? {},
        phase: "deliver",
      });
    } catch {
      return "retry";
    }
    if (!allowed) return "dropped";
    const secret = await openOrEmpty(sub.encryptedSecret);
    if (!secret) return "dropped"; // sealed under a rotated key: wait for the host's refresh
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
    // Release the connection: the body is never needed.
    await response.body?.cancel().catch(() => undefined);
    if (response.ok) return "delivered";
    if (response.status === 410) {
      await store.delete(sub);
      return "gone";
    }
    // Redirects are never followed, so retrying one would fail the same way.
    if (response.status === 413 || (response.status >= 300 && response.status < 400)) {
      return "dropped";
    }
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

    const caller = callerOf(ctx);
    const who = await resolvePrincipal(principal, caller);
    if (!who) throw notAuthenticated();
    const owner = who.id;
    if (
      definition.config.authorize &&
      !(await definition.config.authorize(args, {
        principal: owner,
        context: who.context,
        phase: "subscribe",
        auth: caller.auth,
        request: caller.request,
      }))
    ) {
      throw invalid("Not authorized to subscribe with these arguments", "not_authorized");
    }

    const id = await subscriptionId(owner, url, params.name, args);
    const existing = await store.get(id);
    // A refresh with the same secret skips the challenge; a new secret proves the callback again.
    const verified = existing !== null && (await openOrEmpty(existing.encryptedSecret)) === secret;
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
      encryptedSecret:
        verified && existing ? existing.encryptedSecret : await secretBox().seal(secret),
      subscriber: owner,
      ...(Object.keys(who.context).length > 0 ? { context: who.context } : {}),
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
    const owner = (await resolvePrincipal(principal, callerOf(ctx)))?.id;
    if (!owner) throw notAuthenticated();
    const parsed = definitions.get(params.name)?.input.safeParse(params.arguments ?? {});
    if (parsed?.success && params.delivery.url) {
      const args = parsed.data as Record<string, unknown>;
      await store.delete({
        id: await subscriptionId(owner, params.delivery.url, params.name, args),
        event: params.name,
        argsKey: canonicalJson(args),
      });
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
        timeoutMs,
        fetch: options.fetch,
      });
      const text = await readCapped(response, MAX_CHALLENGE_RESPONSE_BYTES);
      if (!response.ok) detail = `HTTP ${response.status}`;
      else if (parseChallenge(text) !== challenge) detail = "challenge not echoed";
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
      events: list(),
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
      throw new Error("This delivery sends in-process and has no endpoint. Use QStashDelivery.");
    }
    return delivery.createDeliveryHandler();
  }

  const list = () => [...definitions.values()].map((d) => d.descriptor);

  delivery.attach?.({ send });

  return { define, register, createDeliveryHandler, list };
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

/** Deterministic, as the draft asks: same subscriber, callback, event and arguments give the same id. */
export async function subscriptionId(
  subscriber: string,
  url: string,
  event: string,
  args: Record<string, unknown>,
): Promise<string> {
  return `sub_${(await sha256Hex(canonicalJson([subscriber, url, event, args]))).slice(0, 32)}`;
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

function parseChallenge(text: string): unknown {
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

function getEnv(name: string): string | undefined {
  return typeof process === "object" ? process.env?.[name] : undefined;
}
