/**
 * The events runtime, exercised through a real `McpServer` over JSON-RPC. The "host" is a stubbed
 * global `fetch` that plays the callback receiver: it answers the verification challenge and
 * checks the Standard Webhooks signature on every POST, the way ChatGPT's receiver does.
 */
import { randomBytes } from "node:crypto";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as z from "zod";
import { createEventLayer, type EventLayerOptions } from "./core.js";
import { SecretBox, callbackUrlProblem, verifyWebhook } from "./webhooks.js";
import type { EventEnvelope } from "./types.js";
import {
  InlineDelivery,
  MemorySubscriptionStore,
  TEST_SECRET_KEY,
  userIdOf,
} from "../test-support.js";

const PROTOCOL_VERSION = "2026-07-28";
const newSecret = () => `whsec_${randomBytes(32).toString("base64")}`;

type Received = { url: string; headers: Headers; body: Record<string, unknown>; valid: boolean };
type Respond = (r: Received) => Response | undefined;

/** A callback receiver. `respond` may override each answer after the signature is checked. */
function host(secrets: Map<string, string>, respond?: Respond) {
  const received: Received[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: Parameters<typeof fetch>[1]) => {
    const url = String(input);
    const raw = String(init?.body ?? "");
    const headers = new Headers(init?.headers);
    const secret = secrets.get(url) ?? "";
    const r: Received = {
      url,
      headers,
      body: JSON.parse(raw) as Record<string, unknown>,
      valid: await verifyWebhook(secret, headers, raw),
    };
    received.push(r);
    const custom = respond?.(r);
    if (custom) return custom;
    if (!r.valid) return new Response("bad signature", { status: 401 });
    if (r.body.type === "verification") return Response.json({ challenge: r.body.challenge });
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  return {
    fetch: fetchImpl,
    received,
    deliveries: () => received.filter((r) => r.body.type !== "verification"),
  };
}

type JsonRpc = {
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: { reason?: string } };
};

const meta = {
  "io.modelcontextprotocol/protocolVersion": PROTOCOL_VERSION,
  "io.modelcontextprotocol/clientInfo": { name: "host", version: "1.0.0" },
  "io.modelcontextprotocol/clientCapabilities": {},
};

function request(method: string, params: Record<string, unknown>, id: number): Request {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": PROTOCOL_VERSION,
    "mcp-method": method,
  };
  return new Request("http://localhost/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params: { ...params, _meta: meta } }),
  });
}

/** Requests run as "alice" unless told otherwise; `null` sends no auth at all. */
const as = (given?: string | null) => {
  const user = given === undefined ? "alice" : given;
  return user
    ? { authInfo: { token: "t", clientId: "chatgpt", scopes: [], extra: { userId: user } } }
    : undefined;
};

afterEach(() => {
  vi.unstubAllGlobals();
});

function setup(
  options: Partial<EventLayerOptions> & { respond?: Respond; fetch?: typeof fetch } = {},
) {
  const { respond, fetch: fetchOverride, ...layerOptions } = options;
  const secrets = new Map<string, string>();
  const receiver = host(secrets, respond);
  vi.stubGlobal("fetch", fetchOverride ?? receiver.fetch);
  const store = new MemorySubscriptionStore();
  const delivery = new InlineDelivery();
  // Who may read which document. Documents not listed are readable by everyone, except secret-doc.
  const acl = new Map<string, Set<string>>();
  const authorized: { args: unknown; phase: string; principal: string }[] = [];
  const canRead = (user: string, documentId: string | undefined) =>
    documentId !== "secret-doc" &&
    (documentId === undefined || (acl.get(documentId)?.has(user) ?? true));
  const events = createEventLayer({
    store,
    delivery,
    secretKey: TEST_SECRET_KEY,
    principal: userIdOf,
    ...layerOptions,
  });

  const commentCreated = events.define("comment.created", {
    description: "A new comment on a document.",
    input: z.object({
      documentId: z.string().optional(),
      author: z.string().optional(),
    }),
    payload: z.object({ documentId: z.string(), author: z.string(), text: z.string() }),
    authorize: (args, { principal, phase }) => {
      authorized.push({ args, phase, principal });
      return canRead(principal, args.documentId);
    },
  });
  events.createDeliveryHandler(); // connects the inline delivery, as serving the route does

  const handler = createMcpHandler(() => {
    const server = new McpServer({ name: "test", version: "1.0.0" });
    events.register(server);
    return server;
  });

  let id = 0;
  const rpc = async (
    method: string,
    params: Record<string, unknown> = {},
    user?: string | null,
  ) => {
    const response = await handler.fetch(request(method, params, ++id), as(user));
    return JSON.parse(await response.text()) as JsonRpc;
  };

  const subscribe = async (
    args: Record<string, unknown>,
    opts: {
      user?: string | null;
      url?: string;
      secret?: string;
      ttlMs?: number | null;
      name?: string;
    } = {},
  ) => {
    const url = opts.url ?? `https://receiver.example.com/cb/${randomBytes(4).toString("hex")}`;
    const secret = opts.secret ?? newSecret();
    secrets.set(url, secret);
    const response = await rpc(
      "events/subscribe",
      {
        name: opts.name ?? "comment.created",
        arguments: args,
        delivery: { mode: "webhook", url, secret },
        ...(opts.ttlMs === undefined ? {} : { ttlMs: opts.ttlMs }),
      },
      opts.user,
    );
    return { ...response, url, secret };
  };

  const unsubscribe = (args: Record<string, unknown>, url: string, user?: string | null) =>
    rpc(
      "events/unsubscribe",
      { name: "comment.created", arguments: args, delivery: { mode: "webhook", url } },
      user,
    );

  const done = () => delivery.outcomes.map((o) => o.done);

  return {
    events,
    store,
    rpc,
    subscribe,
    unsubscribe,
    receiver,
    done,
    commentCreated,
    acl,
    authorized,
  };
}

describe("events/list and capability", () => {
  it("declares the events capability and lists descriptors with JSON schemas", async () => {
    const { rpc } = setup();
    const discover = await rpc("server/discover");
    expect((discover.result?.capabilities as Record<string, unknown>).events).toEqual({});

    const list = await rpc("events/list");
    const [event] = list.result?.events as Record<string, unknown>[];
    expect(event).toMatchObject({
      name: "comment.created",
      description: "A new comment on a document.",
      delivery: ["webhook"],
      inputSchema: { type: "object" },
      payloadSchema: { type: "object" },
    });
    expect(list.result?.nextCursor).toBeNull();
  });
});

describe("events/subscribe", () => {
  it("verifies the callback with a signed challenge, then returns a deterministic id", async () => {
    const { subscribe, receiver } = setup();
    const url = "https://r.example.com/a";
    const first = await subscribe({ documentId: "doc_1" }, { user: "alice", url });
    expect(first.error).toBeUndefined();
    expect(first.result).toMatchObject({ cursor: null, truncated: false });
    expect(String(first.result?.id)).toMatch(/^sub_[0-9a-f]{32}$/);
    expect(Date.parse(String(first.result?.refreshBefore))).toBeGreaterThan(Date.now());

    const challenge = receiver.received[0]!;
    expect(challenge.valid).toBe(true);
    expect(challenge.body.type).toBe("verification");
    expect(challenge.headers.get("webhook-id")).toMatch(/^msg_verification_/);
    expect(challenge.headers.get("x-mcp-subscription-id")).toBe(first.result?.id);

    // Same identity, same id; a refresh with the same secret skips the challenge.
    const again = await subscribe(
      { documentId: "doc_1" },
      { user: "alice", url, secret: first.secret },
    );
    expect(again.result?.id).toBe(first.result?.id);
    expect(receiver.received).toHaveLength(1);

    // A different user is a different subscription.
    const bob = await subscribe(
      { documentId: "doc_1" },
      { user: "bob", url: "https://r.example.com/b" },
    );
    expect(bob.result?.id).not.toBe(first.result?.id);
  });

  it("re-verifies when the secret rotates", async () => {
    const { subscribe, receiver } = setup();
    await subscribe({ documentId: "d" }, { url: "https://r.example.com/x" });
    await subscribe({ documentId: "d" }, { url: "https://r.example.com/x" });
    expect(receiver.received.filter((r) => r.body.type === "verification")).toHaveLength(2);
  });

  it("refuses with -32015 when the callback does not echo the challenge", async () => {
    const { subscribe, store } = setup({ respond: () => Response.json({ challenge: "nope" }) });
    const response = await subscribe({ documentId: "doc_1" });
    expect(response.error?.code).toBe(-32015);
    expect(await store.find("comment.created")).toHaveLength(0);
  });

  it("gives the same error whatever went wrong, so the network behind it cannot be probed", async () => {
    const outcomes = [
      {
        fetch: (async () => {
          throw new TypeError("fetch failed");
        }) as typeof fetch,
      },
      {
        fetch: (async () => {
          throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
        }) as typeof fetch,
      },
      { respond: () => new Response("no", { status: 500 }) },
      { respond: () => new Response(null, { status: 302 }) },
      { respond: () => Response.json({ challenge: "nope" }) },
    ];
    const errors = [];
    for (const options of outcomes) {
      errors.push((await setup(options).subscribe({ documentId: "d" })).error);
    }
    for (const error of errors) {
      expect(error).toEqual(errors[0]);
      expect(error?.code).toBe(-32015);
    }
  });

  it("reads only the start of a huge challenge response", async () => {
    const { subscribe } = setup({ respond: () => new Response("x".repeat(5_000_000)) });
    expect((await subscribe({ documentId: "d" })).error?.code).toBe(-32015);
  });

  it("validates event name, mode, arguments, secret, URL and authorization", async () => {
    const { subscribe, rpc } = setup();
    const reason = async (p: ReturnType<typeof subscribe>) => (await p).error?.data?.reason;
    expect(await reason(subscribe({ documentId: "d" }, { name: "nope" }))).toBe("unknown_event");
    expect(await reason(subscribe({ documentId: 42 }))).toBe("invalid_arguments");
    expect(await reason(subscribe({ documentId: "d" }, { secret: "whsec_c2hvcnQ=" }))).toBe(
      "invalid_secret",
    );
    expect(
      await reason(subscribe({ documentId: "d" }, { url: "http://receiver.example.com/x" })),
    ).toBe("invalid_callback_url");
    expect(
      await reason(subscribe({ documentId: "d" }, { url: "https://169.254.169.254/latest" })),
    ).toBe("invalid_callback_url");
    expect(await reason(subscribe({ documentId: "secret-doc" }))).toBe("not_authorized");
    const poll = await rpc("events/subscribe", {
      name: "comment.created",
      arguments: { documentId: "d" },
      delivery: { mode: "poll" },
    });
    expect(poll.error?.data?.reason).toBe("unsupported_delivery_mode");
  });

  it("refuses the subscribe, and sends no challenge, when authorize throws", async () => {
    const { events, subscribe, receiver } = setup();
    events.define("flaky", {
      description: "d",
      payload: z.object({}),
      authorize: () => {
        throw new Error("permission service is down");
      },
    });
    const result = await subscribe({}, { name: "flaky" });
    expect(result.error).toBeDefined();
    expect(result.result).toBeUndefined();
    expect(receiver.received).toHaveLength(0);
  });

  it("grants the requested ttl, capped at 30 days", async () => {
    const { subscribe, store } = setup();
    const day = 24 * 60 * 60 * 1000;
    const short = await subscribe({ documentId: "a" }, { ttlMs: 10_000 });
    const long = await subscribe({ documentId: "b" }, { ttlMs: 10 ** 12 });
    const unlimited = await subscribe({ documentId: "c" }, { ttlMs: null });
    const ttlOf = async (id: unknown) => (await store.get(String(id)))!.expiresAt - Date.now();
    expect(await ttlOf(short.result?.id)).toBeLessThanOrEqual(10_000);
    expect(await ttlOf(long.result?.id)).toBeLessThanOrEqual(30 * day);
    expect(await ttlOf(long.result?.id)).toBeGreaterThan(29 * day);
    expect(await ttlOf(unlimited.result?.id)).toBeGreaterThan(29 * day);
  });
});

describe("emit", () => {
  it("delivers a signed envelope to every subscription whose arguments match", async () => {
    const { subscribe, commentCreated, receiver } = setup();
    const all = await subscribe({ documentId: "doc_1" });
    const byAlice = await subscribe({ documentId: "doc_1", author: "alice" });
    await subscribe({ documentId: "doc_1", author: "bob" });
    await subscribe({ documentId: "doc_2" });

    const result = await commentCreated.emit({ documentId: "doc_1", author: "alice", text: "hi" });
    const deliveries = receiver.deliveries();
    expect(deliveries.map((d) => d.url).sort()).toEqual([all.url, byAlice.url].sort());
    for (const delivery of deliveries) {
      expect(delivery.valid).toBe(true);
      expect(delivery.body as EventEnvelope).toMatchObject({
        eventId: result.eventId,
        name: "comment.created",
        cursor: null,
        data: { text: "hi" },
      });
      expect(delivery.headers.get("webhook-id")).toBe(result.eventId);
    }
  });

  it("uses a given eventId, so the host can drop a repeated emit", async () => {
    const { subscribe, commentCreated, receiver } = setup();
    await subscribe({ documentId: "d" });
    const result = await commentCreated.emit(
      { documentId: "d", author: "a", text: "x" },
      { eventId: "deploy_42" },
    );
    expect(result.eventId).toBe("deploy_42");
    expect(receiver.deliveries()[0]?.headers.get("webhook-id")).toBe("deploy_42");
  });

  it("rejects an invalid payload and an oversized one", async () => {
    const { commentCreated } = setup();
    await expect(commentCreated.emit({ documentId: "d" } as never)).rejects.toThrow();
    await expect(
      commentCreated.emit({ documentId: "d", author: "a", text: "x".repeat(300 * 1024) }),
    ).rejects.toThrow(/limit/);
  });

  it("deletes the subscription on 410, drops 413 and redirects, and retries the rest", async () => {
    let status = 410;
    const { subscribe, commentCreated, done, store } = setup({
      respond: (r) => (r.body.type === "verification" ? undefined : new Response(null, { status })),
    });
    const sub = await subscribe({ documentId: "d" });
    await commentCreated.emit({ documentId: "d", author: "a", text: "1" });
    expect(done()).toEqual([true]);
    expect(await store.get(String(sub.result?.id))).toBeNull();

    await subscribe({ documentId: "d" });
    for (const next of [413, 503, 307, 400]) {
      status = next;
      await commentCreated.emit({ documentId: "d", author: "a", text: String(next) });
    }
    // A redirect is never followed, so retrying it cannot help either.
    expect(done()).toEqual([true, true, false, true, false]);
  });

  it("stops delivering after unsubscribe", async () => {
    const { subscribe, unsubscribe, commentCreated, receiver } = setup();
    const sub = await subscribe({ documentId: "d" }, { user: "alice" });
    expect((await unsubscribe({ documentId: "d" }, sub.url, "alice")).result).toBeDefined();
    await commentCreated.emit({ documentId: "d", author: "a", text: "x" });
    expect(receiver.deliveries()).toHaveLength(0);
  });

  it("keeps secrets encrypted at rest", async () => {
    const { subscribe, store } = setup();
    const sub = await subscribe({ documentId: "d" });
    const stored = await store.get(String(sub.result?.id));
    expect(stored?.encryptedSecret).toMatch(/^v1\./);
    expect(JSON.stringify(stored)).not.toContain(sub.secret.slice(6));
  });
});

describe("access across users", () => {
  /** alice and carol may read doc_shared; mallory may not. */
  const shared = () => {
    const env = setup();
    env.acl.set("doc_shared", new Set(["alice", "carol"]));
    return env;
  };
  const comment = { documentId: "doc_shared", author: "dave", text: "Ship it?" };

  it("lets readers subscribe, refuses everyone else, and delivers to each reader", async () => {
    const { subscribe, commentCreated, receiver, store } = shared();

    const alice = await subscribe({ documentId: "doc_shared" }, { user: "alice" });
    expect(alice.error).toBeUndefined();

    // mallory can't read the document, so the subscribe is refused before any challenge.
    const challengesBefore = receiver.received.length;
    const mallory = await subscribe({ documentId: "doc_shared" }, { user: "mallory" });
    expect(mallory.error?.data?.reason).toBe("not_authorized");
    expect(receiver.received).toHaveLength(challengesBefore);
    expect(await store.find("comment.created")).toHaveLength(1);

    const carol = await subscribe({ documentId: "doc_shared" }, { user: "carol" });
    expect(carol.error).toBeUndefined();

    // One emit, no recipients named: both readers hear it, each on their own signed callback.
    const result = await commentCreated.emit(comment);
    const deliveries = receiver.deliveries();
    expect(deliveries.map((d) => d.url).sort()).toEqual([alice.url, carol.url].sort());
    for (const delivery of deliveries) {
      expect(delivery.valid).toBe(true);
      expect(delivery.body).toMatchObject({ eventId: result.eventId, data: comment });
    }
  });

  it("checks a subscriber without a filter against each event's own values", async () => {
    // The hazard this guards: a subscription with no arguments matches every emit, so checking
    // only its (empty) arguments at delivery would hand mallory comments on documents she cannot
    // read. authorize is asked about the event's documentId instead.
    const { subscribe, commentCreated, receiver, authorized } = shared();
    const mallory = await subscribe({}, { user: "mallory" });
    expect(mallory.error).toBeUndefined();

    await commentCreated.emit(comment);
    await commentCreated.emit({ documentId: "doc_public", author: "dave", text: "Hello" });

    expect(receiver.deliveries().map((d) => (d.body.data as { text: string }).text)).toEqual([
      "Hello",
    ]);
    expect(authorized.filter((a) => a.phase === "deliver")).toEqual([
      {
        phase: "deliver",
        principal: "mallory",
        args: { documentId: "doc_shared", author: "dave" },
      },
      {
        phase: "deliver",
        principal: "mallory",
        args: { documentId: "doc_public", author: "dave" },
      },
    ]);
  });

  it("stops delivering to a subscriber whose access was revoked after subscribing", async () => {
    const { subscribe, commentCreated, receiver, done, acl } = shared();
    const alice = await subscribe({ documentId: "doc_shared" }, { user: "alice" });
    await subscribe({ documentId: "doc_shared" }, { user: "carol" });

    acl.set("doc_shared", new Set(["alice"])); // carol loses access
    await commentCreated.emit(comment);

    expect(receiver.deliveries().map((d) => d.url)).toEqual([alice.url]);
    // A refusal is final: retrying would be refused again.
    expect(done()).toEqual([true, true]);
  });

  it("retries a delivery, rather than dropping it, when authorize throws", async () => {
    const { events, subscribe, receiver, done } = setup();
    let down = true;
    const memo = events.define("memo.posted", {
      description: "d",
      payload: z.object({ text: z.string() }),
      authorize: (_args, { phase }) => {
        if (phase === "deliver" && down) throw new Error("permission service is down");
        return true;
      },
    });
    await subscribe({}, { name: "memo.posted" });
    await memo.emit({ text: "hi" });
    expect(done()).toEqual([false]);
    expect(receiver.deliveries()).toHaveLength(0);
    down = false;
  });

  it("gives authorize the verified auth at subscribe time only", async () => {
    const seen: { phase: string; hasAuth: boolean }[] = [];
    const { events, subscribe } = setup();
    const memo = events.define("memo.posted", {
      description: "d",
      payload: z.object({ text: z.string() }),
      authorize: (_args, caller) => {
        seen.push({ phase: caller.phase, hasAuth: caller.auth !== undefined });
        return true;
      },
    });
    await subscribe({}, { name: "memo.posted" });
    await memo.emit({ text: "hi" });
    // The token is never stored, so only the subscribe-time check sees `auth`.
    expect(seen).toEqual([
      { phase: "subscribe", hasAuth: true },
      { phase: "deliver", hasAuth: false },
    ]);
  });

  it("never lets one user unsubscribe another's subscription", async () => {
    const { subscribe, unsubscribe, commentCreated, receiver } = setup();
    const alice = await subscribe({ documentId: "d" }, { user: "alice" });
    // mallory knows the event, the arguments and even the callback URL.
    expect((await unsubscribe({ documentId: "d" }, alice.url, "mallory")).result).toBeDefined();
    await commentCreated.emit({ documentId: "d", author: "a", text: "still here" });
    expect(receiver.deliveries().map((d) => d.url)).toEqual([alice.url]);
  });

  it("never lets one user overwrite another's subscription by re-subscribing", async () => {
    const { subscribe, commentCreated, receiver, store } = setup();
    const alice = await subscribe({ documentId: "d" }, { user: "alice" });
    const mallory = await subscribe({ documentId: "d" }, { user: "mallory", url: alice.url });
    expect(mallory.result?.id).not.toBe(alice.result?.id);
    expect((await store.get(String(alice.result?.id)))?.subscriber).toBe("alice");
    await commentCreated.emit({ documentId: "d", author: "a", text: "x" });
    expect(receiver.deliveries()).toHaveLength(2);
  });
});

describe("subscription limit", () => {
  it("allows 8 live subscriptions per subscriber by default, and refuses the 9th unchallenged", async () => {
    const { subscribe, receiver } = setup();
    for (let i = 0; i < 8; i++) {
      expect((await subscribe({ documentId: `d${i}` })).error).toBeUndefined();
    }
    const challenges = receiver.received.length;
    const ninth = await subscribe({ documentId: "d8" });
    expect(ninth.error?.data?.reason).toBe("subscription_limit");
    // Refused before the challenge: a caller at the limit can't make the server POST anywhere.
    expect(receiver.received).toHaveLength(challenges);
    // Other subscribers have their own allowance.
    expect((await subscribe({ documentId: "d8" }, { user: "bob" })).error).toBeUndefined();
  });

  it("still lets a subscriber at the limit refresh, and frees a slot on unsubscribe", async () => {
    const { subscribe, unsubscribe } = setup({ maxSubscriptions: 2 });
    const first = await subscribe({ documentId: "a" });
    await subscribe({ documentId: "b" });
    expect((await subscribe({ documentId: "c" })).error?.data?.reason).toBe("subscription_limit");

    const refresh = await subscribe({ documentId: "a" }, { url: first.url, secret: first.secret });
    expect(refresh.error).toBeUndefined();

    await unsubscribe({ documentId: "a" }, first.url);
    expect((await subscribe({ documentId: "c" })).error).toBeUndefined();
  });

  it("counts only live subscriptions", async () => {
    const { subscribe, store } = setup({ maxSubscriptions: 1 });
    const first = await subscribe({ documentId: "a" });
    const stored = (await store.get(String(first.result?.id)))!;
    store.subscriptions.set(stored.id, { ...stored, expiresAt: Date.now() - 1 });
    expect((await subscribe({ documentId: "b" })).error).toBeUndefined();
  });

  it("is configurable, and can be turned off", async () => {
    const { subscribe } = setup({ maxSubscriptions: Infinity });
    for (let i = 0; i < 12; i++) {
      expect((await subscribe({ documentId: `d${i}` })).error).toBeUndefined();
    }
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(() => setup({ maxSubscriptions: bad })).toThrow(/maxSubscriptions/);
    }
  });
});

describe("define", () => {
  it("requires authorize", () => {
    const { events } = setup();
    expect(() =>
      events.define("open", { description: "d", payload: z.object({}) } as never),
    ).toThrow(/authorize/);
  });

  it("requires every input field to be a payload field, so emits are routed by the payload", () => {
    const { events } = setup();
    expect(() =>
      events.define("reply.posted", {
        description: "A reply was posted in a thread.",
        input: z.object({ threadId: z.string() }),
        payload: z.object({ text: z.string() }), // no threadId in the payload
        authorize: () => true,
      }),
    ).toThrow(/threadId.*payload/);
  });

  it("routes an emit by the payload's values", async () => {
    const { subscribe, commentCreated, receiver } = setup();
    const sub = await subscribe({ documentId: "doc_9" });
    await subscribe({ documentId: "doc_8" });
    await commentCreated.emit({ documentId: "doc_9", author: "a", text: "t" });
    expect(receiver.deliveries().map((d) => d.url)).toEqual([sub.url]);
  });
});

describe("routing through the input schema", () => {
  it("applies the input's transforms to the payload's values before matching and authorizing", async () => {
    const { events, subscribe, receiver } = setup();
    const seen: unknown[] = [];
    const pushed = events.define("repo.pushed", {
      description: "A push.",
      input: z.object({ repo: z.string().trim().toLowerCase() }),
      payload: z.object({ repo: z.string(), sha: z.string() }),
      authorize: (args) => {
        seen.push(args.repo);
        return true;
      },
    });
    await subscribe({ repo: "Upstash/AgentKit" }, { name: "repo.pushed" });
    await pushed.emit({ repo: " UPSTASH/agentkit", sha: "abc" });
    expect(receiver.deliveries()).toHaveLength(1);
    expect(seen).toEqual(["upstash/agentkit", "upstash/agentkit"]);
  });

  it("refuses an emit whose values don't fit the input schema", async () => {
    const { events } = setup();
    const build = events.define("build.done", {
      description: "A build.",
      input: z.object({ id: z.number() }),
      payload: z.object({ id: z.string() }),
      authorize: () => true,
    });
    await expect(build.emit({ id: "x" })).rejects.toThrow(/don't fit the input schema/);
  });
});

describe("principal", () => {
  it("refuses to subscribe or unsubscribe a caller it cannot identify", async () => {
    const { subscribe, unsubscribe, receiver } = setup();
    const anonymous = await subscribe({ documentId: "d" }, { user: null });
    expect(anonymous.error?.data?.reason).toBe("not_authenticated");
    // Refused before the challenge: nothing was posted to the callback.
    expect(receiver.received).toHaveLength(0);

    const off = await unsubscribe({ documentId: "d" }, anonymous.url, null);
    expect(off.error?.data?.reason).toBe("not_authenticated");
  });

  it("refuses before validating anything, so an anonymous caller learns nothing", async () => {
    const { subscribe } = setup();
    const unknown = await subscribe({ documentId: "d" }, { user: null, name: "nope" });
    expect(unknown.error?.data?.reason).toBe("not_authenticated");
    const badUrl = await subscribe({}, { user: null, url: "https://10.0.0.1/x" });
    expect(badUrl.error?.data?.reason).toBe("not_authenticated");
  });

  it("refuses when principal throws, rejects, or returns no usable id", async () => {
    const resolvers = [
      () => {
        throw new Error("no session");
      },
      async () => {
        throw new Error("session store is down");
      },
      () => "",
      () => undefined,
      () => ({ id: "alice" }),
      () => 42,
    ];
    for (const resolver of resolvers) {
      const { subscribe, receiver, store } = setup({ principal: resolver as never });
      const result = await subscribe({ documentId: "d" });
      expect(result.error?.data?.reason).toBe("not_authenticated");
      expect(receiver.received).toHaveLength(0);
      expect(await store.find("comment.created")).toHaveLength(0);
    }
  });

  it("has no default secret key: a missing one fails the first subscribe", async () => {
    const saved = process.env.MCP_EVENTS_SECRET_KEY;
    delete process.env.MCP_EVENTS_SECRET_KEY;
    try {
      // Building the layer must not throw (it runs at module scope, at build time)...
      const { subscribe } = setup({ secretKey: undefined });
      // ...but using it without a key does.
      const result = await subscribe({ documentId: "d" });
      expect(result.error?.message).toMatch(/secretKey/);
    } finally {
      if (saved !== undefined) process.env.MCP_EVENTS_SECRET_KEY = saved;
    }
  });

  it("can identify the caller from the raw request, e.g. a session cookie", async () => {
    // No AuthInfo at all: an app that authenticates with its own session reads the request.
    const { subscribe, store } = setup({
      principal: async ({ request }) => {
        if (!request) throw new Error("no session");
        return "session-user";
      },
    });
    const sub = await subscribe({ documentId: "d" }, { user: null });
    expect(sub.error).toBeUndefined();
    expect((await store.get(String(sub.result?.id)))?.subscriber).toBe("session-user");
  });

  it("is required", () => {
    expect(() =>
      createEventLayer({
        store: new MemorySubscriptionStore(),
        delivery: new InlineDelivery(),
        secretKey: TEST_SECRET_KEY,
      } as unknown as EventLayerOptions),
    ).toThrow(/principal/);
  });
});

describe("the secret key", () => {
  it("must be base64 of at least 32 random bytes", () => {
    for (const weak of ["test-key", "hunter2", Buffer.alloc(16).toString("base64"), ""]) {
      expect(() => new SecretBox(weak), weak).toThrow(/32 random bytes/);
    }
    expect(() => new SecretBox(TEST_SECRET_KEY)).not.toThrow();
  });

  it("refuses a weak key at the first subscribe", async () => {
    const { subscribe } = setup({ secretKey: "password" });
    expect((await subscribe({ documentId: "d" })).error?.message).toMatch(/32 random bytes/);
  });

  it("opens nothing that was tampered with or sealed under another key", async () => {
    const box = new SecretBox(TEST_SECRET_KEY);
    const sealed = await box.seal("whsec_abc");
    expect(await box.open(sealed)).toBe("whsec_abc");
    const [version, iv, payload] = sealed.split(".");
    const flipped = Buffer.from(payload!, "base64");
    flipped[0]! ^= 1;
    expect(await box.open(`${version}.${iv}.${flipped.toString("base64")}`)).toBeNull();
    expect(await new SecretBox(Buffer.alloc(32, 9).toString("base64")).open(sealed)).toBeNull();
    expect(await box.open("garbage")).toBeNull();
  });

  it("drops deliveries for secrets sealed under a rotated key, until the host refreshes", async () => {
    const { subscribe, store, receiver, done, commentCreated } = setup();
    const sub = await subscribe({ documentId: "d" });
    const stored = (await store.get(String(sub.result?.id)))!;
    const otherKey = new SecretBox(Buffer.alloc(32, 9).toString("base64"));
    await store.put(
      { ...stored, encryptedSecret: await otherKey.seal(sub.secret) },
      { limit: Infinity },
    );

    await commentCreated.emit({ documentId: "d", author: "a", text: "x" });
    expect(receiver.deliveries()).toHaveLength(0);
    expect(done()).toEqual([true]);
  });
});

describe("callback URLs", () => {
  it("refuses every IP literal and every name on the server's own network", () => {
    for (const url of [
      "http://example.com",
      "https://localhost/x",
      "https://10.0.0.1/x",
      "https://192.168.1.1/x",
      "https://8.8.8.8/cb",
      "https://[::1]/x",
      "https://[::ffff:127.0.0.1]/x",
      "https://[2606:4700:4700::1111]/cb",
      "https://metadata.google.internal/x",
      "https://user:pw@example.com/x",
      "https://intranet/x",
      // Trailing dots resolve like the bare name.
      "https://localhost./x",
      "https://foo.internal./x",
      "https://x.local./x",
      // IPv4 written another way: the URL parser normalizes it to a literal, which is refused.
      "https://0x7f000001/x",
      "https://2130706433/x",
      "https://127.1/x",
    ]) {
      expect(callbackUrlProblem(url), url).not.toBeNull();
    }
    expect(callbackUrlProblem("https://receiver.example.com/cb")).toBeNull();
    expect(callbackUrlProblem("https://receiver.example.com./cb")).toBeNull();
    expect(callbackUrlProblem("http://localhost:3000/cb", true)).toBeNull();
  });
});
