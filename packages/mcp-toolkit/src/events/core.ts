/**
 * MCP Events for servers on the official TypeScript SDK: typed event definitions, the three
 * `events/*` methods a host calls, and an owner-scoped `emit` that delivers signed Standard
 * Webhooks POSTs. Webhook delivery only, as ChatGPT ships it.
 */
import { ProtocolError, type McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import {
  authOf,
  requirePrincipal,
  type CallerAuth,
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

export type { CallerAuth };

export type EventLayerOptions = {
  store: SubscriptionStore;
  delivery: EventDelivery;
  /**
   * Encrypts the hosts' signing secrets at rest. Defaults to `MCP_EVENTS_SECRET_KEY`; one of the
   * two is required. Generate one with `openssl rand -base64 32`.
   */
  secretKey?: string;
  /**
   * Who is calling, usually your user id. Required. Every subscription is owned by its caller,
   * `undefined` refuses the subscribe, and `emit` only reaches the owners it names.
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

export type EventConfig<Input extends EventInputSchema, Payload extends z.ZodType> = {
  title?: string;
  /** What the event means, for the model and the user. */
  description: string;
  /** What a subscriber filters on, e.g. `z.object({ repo: z.string() })`. Defaults to none. */
  input?: Input;
  /** The shape of `data` in every delivery. */
  payload: Payload;
  /**
   * Whether this caller may subscribe with these arguments, e.g. whether they can see that
   * document. Runs on every subscribe and refresh. Unset allows any authenticated caller.
   */
  authorize?: (
    args: z.output<Input>,
    caller: { principal: string; auth?: CallerAuth },
  ) => boolean | Promise<boolean>;
  /** An extra filter for what exact argument matching cannot express. Runs per subscription. */
  match?: (args: z.output<Input>, payload: z.output<Payload>) => boolean;
};

/** Who receives an event: one owner, or several (e.g. everyone on a document). */
export type EmitRecipients =
  | { owner: string; owners?: never }
  | { owners: readonly string[]; owner?: never };

export type EmitOptions<Args> = EmitRecipients & {
  /**
   * The values subscriptions are matched on. `{ repo: "a", branch: "main" }` reaches subscribers
   * of `{ repo: "a" }`, of both, and of `{}`. Defaults to the payload fields named in the input.
   */
  args?: Partial<Args>;
  /** Stable across retries and sent as `webhook-id`. Reuse an id to deduplicate an emit. */
  eventId?: string;
  /** Defaults to now. */
  timestamp?: Date;
};

export type EmitResult = {
  eventId: string;
  /** How many subscriptions the event was handed to. */
  matched: number;
};

export type EventHandle<Input extends EventInputSchema, Payload extends z.ZodType> = {
  readonly name: string;
  /** Validates the payload and delivers it to the named owners' matching subscriptions. */
  emit(payload: z.input<Payload>, options: EmitOptions<z.output<Input>>): Promise<EmitResult>;
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
  >(
    name: string,
    config: EventConfig<Input, Payload>,
  ): EventHandle<Input, Payload>;
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
    emitOptions: EmitOptions<unknown>,
  ): Promise<EmitResult> {
    const definition = definitions.get(name);
    if (!definition) throw new Error(`Unknown event "${name}"`);
    const owners =
      emitOptions?.owners ?? (emitOptions?.owner === undefined ? undefined : [emitOptions.owner]);
    if (!owners) {
      throw new Error(
        `emit("${name}") needs \`owner\` or \`owners\`: events only reach the subscriptions of the users you name.`,
      );
    }
    const payload = definition.config.payload.parse(rawPayload);
    const args = (emitOptions.args ?? pickArgs(definition.input, payload)) as Record<
      string,
      unknown
    >;
    const envelope: EventEnvelope = {
      eventId: emitOptions.eventId ?? `evt_${randomHex(12)}`,
      name,
      timestamp: (emitOptions.timestamp ?? new Date()).toISOString(),
      data: payload,
      cursor: null,
    };
    const bytes = new TextEncoder().encode(JSON.stringify(envelope)).length;
    if (bytes > MAX_PAYLOAD_BYTES) throw new EventPayloadTooLargeError(bytes);
    if (owners.length === 0) return { eventId: envelope.eventId, matched: 0 };

    const candidates = await store.find(name, [...new Set(owners)], matchKeys(args));
    const match = definition.config.match;
    const targets = match
      ? candidates.filter((sub) => match(sub.args as never, payload as never))
      : candidates;
    if (targets.length > 0) {
      await delivery.enqueue(targets.map((sub) => ({ subscriptionId: sub.id, envelope })));
    }
    return { eventId: envelope.eventId, matched: targets.length };
  }

  async function send(job: DeliveryJob): Promise<SendOutcome> {
    const sub = await store.get(job.subscriptionId);
    if (!sub) return "dropped";
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

    const auth = authOf(ctx);
    const owner = principal(auth);
    if (owner === undefined) throw notAuthenticated();
    if (
      definition.config.authorize &&
      !(await definition.config.authorize(args, { principal: owner, auth }))
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
      owner,
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
    const owner = principal(authOf(ctx));
    if (owner === undefined) throw notAuthenticated();
    const parsed = definitions.get(params.name)?.input.safeParse(params.arguments ?? {});
    if (parsed?.success && params.delivery.url) {
      const args = parsed.data as Record<string, unknown>;
      await store.delete({
        id: await subscriptionId(owner, params.delivery.url, params.name, args),
        event: params.name,
        argsKey: canonicalJson(args),
        owner,
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

/** Deterministic, as the draft asks: same owner, callback, event and arguments give the same id. */
export async function subscriptionId(
  owner: string,
  url: string,
  event: string,
  args: Record<string, unknown>,
): Promise<string> {
  return `sub_${(await sha256Hex(canonicalJson([owner, url, event, args]))).slice(0, 32)}`;
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
