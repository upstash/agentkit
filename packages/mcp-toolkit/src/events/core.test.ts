/**
 * The events runtime, exercised through a real `McpServer` over JSON-RPC. The "host" is a fake
 * `fetch` that plays the callback receiver: it answers the verification challenge and checks the
 * Standard Webhooks signature on every POST, the way ChatGPT's receiver does.
 */
import { randomBytes } from "node:crypto";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import * as z from "zod";
import { createTaskLayer } from "../tasks/core.js";
import { InlineTaskDispatcher, MemoryTaskStore } from "../tasks/backends/memory.js";
import { createEventLayer, matchKeys, type EventLayerOptions } from "./core.js";
import { InlineDelivery, MemorySubscriptionStore } from "./backends/memory.js";
import { taskFinishedEvent } from "./tasks.js";
import { callbackUrlProblem, verifyWebhook } from "./webhooks.js";
import type { EventEnvelope, SendOutcome } from "./types.js";

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
  if (typeof params.name === "string" && method === "tools/call") headers["mcp-name"] = params.name;
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

function setup(options: Partial<EventLayerOptions> & { respond?: Respond } = {}) {
  const { respond, ...layerOptions } = options;
  const secrets = new Map<string, string>();
  const receiver = host(secrets, respond);
  const outcomes: SendOutcome[] = [];
  const store = new MemorySubscriptionStore();
  const events = createEventLayer({
    store,
    delivery: new InlineDelivery({ onOutcome: (_job, outcome) => outcomes.push(outcome) }),
    secretKey: "test-key",
    principal: ({ auth }) => auth?.extra?.userId as string | undefined,
    fetch: receiver.fetch,
    ...layerOptions,
  });

  const commentCreated = events.define("comment.created", {
    description: "A new comment on a document.",
    input: z.object({ documentId: z.string(), author: z.string().optional() }),
    payload: z.object({ documentId: z.string(), author: z.string(), text: z.string() }),
    authorize: (args) => args.documentId !== "secret-doc",
  });

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

  return { events, store, rpc, subscribe, receiver, outcomes, commentCreated };
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
      inputSchema: { type: "object", required: ["documentId"] },
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
    expect(await store.find("comment.created", ["alice"], ['{"documentId":"doc_1"}'])).toHaveLength(
      0,
    );
  });

  it("gives the same error whatever went wrong, so the network behind it cannot be probed", async () => {
    const errors = await Promise.all(
      [
        setup({
          fetch: (async () => {
            throw new TypeError("fetch failed");
          }) as typeof fetch,
        }),
        setup({
          fetch: (async () => {
            throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
          }) as typeof fetch,
        }),
        setup({ respond: () => new Response("no", { status: 500 }) }),
        setup({ respond: () => new Response(null, { status: 302 }) }),
        setup({ respond: () => Response.json({ challenge: "nope" }) }),
      ].map(async ({ subscribe }) => (await subscribe({ documentId: "d" })).error),
    );
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
    expect(await reason(subscribe({}))).toBe("invalid_arguments");
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

  it("grants the requested ttl, capped at the maximum", async () => {
    const { subscribe, store } = setup({ defaults: { maxTtlMs: 60_000 } });
    const short = await subscribe({ documentId: "a" }, { ttlMs: 10_000 });
    const long = await subscribe({ documentId: "b" }, { ttlMs: 10 ** 10 });
    const unlimited = await subscribe({ documentId: "c" }, { ttlMs: null });
    const ttlOf = async (id: unknown) => (await store.get(String(id)))!.expiresAt - Date.now();
    expect(await ttlOf(short.result?.id)).toBeLessThanOrEqual(10_000);
    expect(await ttlOf(long.result?.id)).toBeLessThanOrEqual(60_000);
    expect(await ttlOf(long.result?.id)).toBeGreaterThan(50_000);
    expect(await ttlOf(unlimited.result?.id)).toBeGreaterThan(50_000);
  });
});

describe("emit", () => {
  it("delivers a signed envelope to every subscription whose arguments match", async () => {
    const { subscribe, commentCreated, receiver } = setup();
    const all = await subscribe({ documentId: "doc_1" });
    const byAlice = await subscribe({ documentId: "doc_1", author: "alice" });
    await subscribe({ documentId: "doc_1", author: "bob" });
    await subscribe({ documentId: "doc_2" });

    const result = await commentCreated.emit(
      { documentId: "doc_1", author: "alice", text: "hi" },
      { owner: "alice" },
    );
    expect(result.matched).toBe(2);
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

  it("matches on explicit args and filters by owner", async () => {
    const { subscribe, commentCreated, receiver } = setup();
    await subscribe({ documentId: "doc_1" }, { user: "alice" });
    const bob = await subscribe({ documentId: "doc_1" }, { user: "bob" });
    const result = await commentCreated.emit(
      { documentId: "ignored", author: "x", text: "y" },
      { args: { documentId: "doc_1" }, owner: "bob" },
    );
    expect(result.matched).toBe(1);
    expect(receiver.deliveries()[0]?.url).toBe(bob.url);
  });

  it("only reaches the owners it names", async () => {
    const { subscribe, commentCreated, receiver } = setup();
    const alice = await subscribe({ documentId: "doc_1" }, { user: "alice" });
    const bob = await subscribe({ documentId: "doc_1" }, { user: "bob" });
    const payload = { documentId: "doc_1", author: "x", text: "y" };

    expect((await commentCreated.emit(payload, { owner: "alice" })).matched).toBe(1);
    expect(receiver.deliveries().map((d) => d.url)).toEqual([alice.url]);
    expect((await commentCreated.emit(payload, { owner: "mallory" })).matched).toBe(0);
    expect((await commentCreated.emit(payload, { owners: ["alice", "bob"] })).matched).toBe(2);
    expect(
      receiver
        .deliveries()
        .map((d) => d.url)
        .slice(1)
        .sort(),
    ).toEqual([alice.url, bob.url].sort());
    expect((await commentCreated.emit(payload, { owners: [] })).matched).toBe(0);
  });

  it("refuses to emit without naming who receives it", async () => {
    const { commentCreated } = setup();
    await expect(
      commentCreated.emit({ documentId: "d", author: "a", text: "x" }, {} as never),
    ).rejects.toThrow(/owner/);
  });

  it("rejects an invalid payload and an oversized one", async () => {
    const { commentCreated } = setup();
    await expect(
      commentCreated.emit({ documentId: "d" } as never, { owner: "alice" }),
    ).rejects.toThrow();
    await expect(
      commentCreated.emit(
        { documentId: "d", author: "a", text: "x".repeat(300 * 1024) },
        { owner: "alice" },
      ),
    ).rejects.toThrow(/limit/);
  });

  it("deletes the subscription on 410 and does not retry 413", async () => {
    let status = 410;
    const { subscribe, commentCreated, outcomes, store } = setup({
      respond: (r) => (r.body.type === "verification" ? undefined : new Response(null, { status })),
    });
    const sub = await subscribe({ documentId: "d" });
    await commentCreated.emit({ documentId: "d", author: "a", text: "1" }, { owner: "alice" });
    expect(outcomes).toEqual(["gone"]);
    expect(await store.get(String(sub.result?.id))).toBeNull();

    status = 413;
    await subscribe({ documentId: "d" });
    await commentCreated.emit({ documentId: "d", author: "a", text: "2" }, { owner: "alice" });
    status = 503;
    await commentCreated.emit({ documentId: "d", author: "a", text: "3" }, { owner: "alice" });
    // A redirect is never followed, so retrying it cannot help either.
    status = 307;
    await commentCreated.emit({ documentId: "d", author: "a", text: "4" }, { owner: "alice" });
    expect(outcomes).toEqual(["gone", "dropped", "retry", "dropped"]);
  });

  it("stops delivering after unsubscribe", async () => {
    const { subscribe, rpc, commentCreated } = setup();
    const sub = await subscribe({ documentId: "d" }, { user: "alice" });
    const response = await rpc(
      "events/unsubscribe",
      {
        name: "comment.created",
        arguments: { documentId: "d" },
        delivery: { mode: "webhook", url: sub.url },
      },
      "alice",
    );
    expect(response.result).toBeDefined();
    const after = await commentCreated.emit(
      { documentId: "d", author: "a", text: "x" },
      { owner: "alice" },
    );
    expect(after.matched).toBe(0);
  });

  it("keeps secrets encrypted at rest", async () => {
    const { subscribe, store } = setup();
    const sub = await subscribe({ documentId: "d" });
    const stored = await store.get(String(sub.result?.id));
    expect(stored?.encryptedSecret).toMatch(/^v1\./);
    expect(JSON.stringify(stored)).not.toContain(sub.secret.slice(6));
  });
});

describe("principal", () => {
  it("refuses to subscribe or unsubscribe a caller it cannot identify", async () => {
    const { subscribe, rpc, receiver } = setup();
    const anonymous = await subscribe({ documentId: "d" }, { user: null });
    expect(anonymous.error?.data?.reason).toBe("not_authenticated");
    // Refused before the challenge: nothing was posted to the callback.
    expect(receiver.received).toHaveLength(0);

    const off = await rpc(
      "events/unsubscribe",
      {
        name: "comment.created",
        arguments: { documentId: "d" },
        delivery: { mode: "webhook", url: anonymous.url },
      },
      null,
    );
    expect(off.error?.data?.reason).toBe("not_authenticated");
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
      principal: async ({ request }) => (request ? "session-user" : undefined),
    });
    const sub = await subscribe({ documentId: "d" }, { user: null });
    expect(sub.error).toBeUndefined();
    expect((await store.get(String(sub.result?.id)))?.owner).toBe("session-user");
  });

  it("is required", () => {
    expect(() =>
      createEventLayer({
        store: new MemorySubscriptionStore(),
        delivery: new InlineDelivery(),
        secretKey: "k",
      } as unknown as EventLayerOptions),
    ).toThrow(/principal/);
  });
});

describe("task.finished", () => {
  it("fires once when a task settles, only to the owner's subscriptions", async () => {
    const { events, subscribe, receiver } = setup();
    const taskFinished = taskFinishedEvent(events);
    const tasks = createTaskLayer({
      store: new MemoryTaskStore(),
      dispatcher: new InlineTaskDispatcher(),
      principal: ({ auth }) => auth?.extra?.userId as string | undefined,
      onSettle: taskFinished.onSettle,
    });
    tasks.define("slow", { description: "slow", inputSchema: z.object({}) }, async () => ({
      content: [{ type: "text", text: "done" }],
    }));
    const handler = createMcpHandler(() => {
      const server = new McpServer({ name: "t", version: "1.0.0" });
      tasks.register(server);
      return server;
    });

    const alice = await subscribe({}, { user: "alice", name: "task.finished" });
    await subscribe({}, { user: "bob", name: "task.finished" });
    expect(alice.error).toBeUndefined();

    const response = await handler.fetch(
      request("tools/call", { name: "slow", arguments: {} }, 1),
      as("alice"),
    );
    const taskId = (
      JSON.parse(await response.text()) as { result: { structuredContent: { taskId: string } } }
    ).result.structuredContent.taskId;
    await new Promise((resolve) => setTimeout(resolve, 50));

    const deliveries = receiver.deliveries();
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.url).toBe(alice.url);
    expect(deliveries[0]?.body).toMatchObject({
      name: "task.finished",
      eventId: expect.stringMatching(new RegExp(`^evt_task_${taskId}-\\d+$`)),
      data: { taskId, status: "completed", result: { content: [{ type: "text", text: "done" }] } },
    });

    // The event id is per task record, not per task id: a keyed task re-created after its record
    // expired reuses the id, and must not be dropped as a duplicate of the first one's event.
    expect(deliveries[0]?.body.eventId).not.toBe(`evt_task_${taskId}`);

    // A cancel after completion settles nothing, so nothing fires.
    await tasks.cancelTask(taskId);
    expect(receiver.deliveries()).toHaveLength(1);
  });
});

describe("task.finished event ids", () => {
  it("differ for a keyed task re-created after its record expired", async () => {
    const { events } = setup();
    const taskFinished = taskFinishedEvent(events);
    const ids: (string | undefined)[] = [];
    (taskFinished.event as { emit: unknown }).emit = async (
      _payload: unknown,
      options: { eventId?: string },
    ) => {
      ids.push(options.eventId);
      return { eventId: options.eventId ?? "", matched: 0 };
    };
    const record = {
      taskId: "keyed",
      status: "completed" as const,
      lastUpdatedAt: "2026-10-08T10:00:01.000Z",
      ttlMs: 300_000,
      name: "slow",
      args: {},
      owner: "alice",
    };
    await taskFinished.onSettle({ ...record, createdAt: "2026-10-08T10:00:00.000Z" });
    await taskFinished.onSettle({ ...record, createdAt: "2026-10-08T10:06:00.000Z" });
    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);
  });
});

describe("helpers", () => {
  it("enumerates every subset of the emitted arguments", () => {
    expect(matchKeys({ a: 1, b: 2 }).sort()).toEqual(
      ['{"a":1,"b":2}', '{"a":1}', '{"b":2}', "{}"].sort(),
    );
    const tooMany = Object.fromEntries([...Array(9).keys()].map((i) => [`k${i}`, i]));
    expect(() => matchKeys(tooMany)).toThrow();
  });

  it("refuses callback URLs that point at the server's own network", () => {
    for (const url of [
      "http://example.com",
      "https://localhost/x",
      "https://10.0.0.1/x",
      "https://192.168.1.1/x",
      "https://[::1]/x",
      "https://[::ffff:127.0.0.1]/x",
      "https://metadata.google.internal/x",
      "https://user:pw@example.com/x",
      "https://intranet/x",
      // Trailing dots resolve like the bare name.
      "https://localhost./x",
      "https://foo.internal./x",
      "https://x.local./x",
      // IPv4 written another way, or embedded in IPv6.
      "https://0x7f000001/x",
      "https://[::127.0.0.1]/x",
      "https://[64:ff9b::127.0.0.1]/x",
      "https://[64:ff9b:1::1]/x",
      "https://[2002:7f00:1::]/x",
      "https://[fe80::1]/x",
      "https://[fd00::1]/x",
      // Reserved and documentation ranges.
      "https://198.18.0.1/x",
      "https://192.0.0.1/x",
      "https://192.0.2.1/x",
      "https://198.51.100.1/x",
      "https://203.0.113.1/x",
    ]) {
      expect(callbackUrlProblem(url), url).not.toBeNull();
    }
    expect(callbackUrlProblem("https://receiver.example.com/cb")).toBeNull();
    expect(callbackUrlProblem("https://8.8.8.8/cb")).toBeNull();
    expect(callbackUrlProblem("https://receiver.example.com./cb")).toBeNull();
    expect(callbackUrlProblem("https://[2606:4700:4700::1111]/cb")).toBeNull();
    expect(callbackUrlProblem("https://[64:ff9b::8.8.8.8]/cb")).toBeNull();
    expect(callbackUrlProblem("http://localhost:3000/cb", true)).toBeNull();
  });
});
