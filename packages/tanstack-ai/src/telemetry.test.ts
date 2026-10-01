import { afterEach, describe, expect, test } from "vitest";
import { Redis } from "@upstash/redis";
import { SDK_TELEMETRY } from "@upstash/agentkit-sdk";
import { TANSTACK_AI_TELEMETRY } from "./telemetry.js";
import { VERSION } from "./version.js";
import { upstashPersistence } from "./persistence/persistence.js";
import { upstashBlobStore } from "./persistence/blob-store.js";
import { upstashMemory } from "./memory/memory.js";
import { upstashStream } from "./stream/stream.js";
import { EventLog } from "./stream/event-log.js";
import { upstashLocks } from "./locks/locks.js";
import { RedisLock } from "./locks/redis-lock.js";
import { rateLimit, toolCache } from "./middleware/middleware.js";
import { createSearchTools } from "./search/search-tools.js";
import { Ratelimit } from "@upstash/agentkit-sdk";
import { s } from "@upstash/redis";

/**
 * Proof the tags ride on the wire, not just that the client was told about them: the Upstash client
 * calls the global `fetch`, so stubbing it captures the real outgoing request headers.
 */
const realFetch = globalThis.fetch;
let sent: Record<string, string>[] = [];

function spyOnFetch(): void {
  sent = [];
  globalThis.fetch = (async (_url: unknown, init?: { headers?: Record<string, string> }) => {
    sent.push({ ...init?.headers });
    return new Response(JSON.stringify({ result: "OK" }), { status: 200 });
  }) as unknown as typeof fetch;
}

/** A client pointed at nowhere, one request per command (no auto-pipelining) for the stub above. */
function stubbedRedis(): Redis {
  return new Redis({
    url: "https://telemetry.test.upstash.io",
    token: "test-token",
    responseEncoding: false,
    retry: false,
    enableAutoPipelining: false,
  });
}

/** The tags on the one request `send` makes. */
async function tagsAfter(redis: Redis): Promise<string[]> {
  await redis.set("agentkit:telemetry-test", "value");
  expect(sent.length).toBe(1);
  return (sent[0]?.["Upstash-Telemetry-Sdk"] ?? "").split(",").filter(Boolean);
}

const bucket = {
  put: async () => ({ etag: "e", size: 0 }),
  get: async () => ({ body: new ReadableStream<Uint8Array>() }),
  del: async () => undefined,
};

// Every public factory, each on its own client, with the core tag it should also carry (if any).
const factories: Array<[string, (redis: Redis, enableTelemetry?: boolean) => unknown, boolean]> = [
  [
    "upstashPersistence",
    (redis, e) => upstashPersistence({ redis, ...(e === false ? { enableTelemetry: e } : {}) }),
    false,
  ],
  [
    "upstashBlobStore",
    (redis, e) =>
      upstashBlobStore({
        redis,
        bucket,
        prefix: "p",
        ...(e === false ? { enableTelemetry: e } : {}),
      }),
    false,
  ],
  [
    "upstashStream",
    (redis, e) =>
      upstashStream({ runId: "r" }, { redis, ...(e === false ? { enableTelemetry: e } : {}) }),
    false,
  ],
  [
    "EventLog",
    (redis, e) => new EventLog({ redis, ...(e === false ? { enableTelemetry: e } : {}) }),
    false,
  ],
  [
    "upstashLocks",
    (redis, e) => upstashLocks({ redis, ...(e === false ? { enableTelemetry: e } : {}) }),
    false,
  ],
  [
    "RedisLock",
    (redis, e) => new RedisLock({ redis, ...(e === false ? { enableTelemetry: e } : {}) }),
    false,
  ],
  [
    "upstashMemory",
    (redis, e) => upstashMemory({ redis, ...(e === false ? { enableTelemetry: e } : {}) }),
    true,
  ],
  [
    "toolCache",
    (redis, e) =>
      toolCache({
        redis,
        tools: ["t"],
        userId: "u",
        ...(e === false ? { enableTelemetry: e } : {}),
      }),
    true,
  ],
  [
    "rateLimit",
    (redis, e) =>
      rateLimit({
        redis,
        limiter: Ratelimit.fixedWindow(1, "1 s"),
        identifier: "u",
        ...(e === false ? { enableTelemetry: e } : {}),
      }),
    true,
  ],
  [
    "createSearchTools",
    (redis, e) =>
      createSearchTools({
        redis,
        schema: s.object({ a: s.string() }),
        ...(e === false ? { enableTelemetry: e } : {}),
      }),
    true,
  ],
];

describe("telemetry on the wire", () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("the tag is this package's name and version", () => {
    expect(TANSTACK_AI_TELEMETRY).toBe(`@upstash/agentkit-tanstack-ai@${VERSION}`);
  });

  test.each(factories)("%s tags its client", async (_name, create, withCore) => {
    spyOnFetch();
    const redis = stubbedRedis();
    create(redis);
    const tags = await tagsAfter(redis);
    expect(tags[0]).toMatch(/^@upstash\/redis@/);
    expect(tags).toContain(TANSTACK_AI_TELEMETRY);
    if (withCore) expect(tags).toContain(SDK_TELEMETRY);
  });

  test("a client shared by every factory carries each tag once", async () => {
    spyOnFetch();
    const redis = stubbedRedis();
    for (const [, create] of factories) create(redis);
    const tags = await tagsAfter(redis);
    expect(tags.filter((t) => t === TANSTACK_AI_TELEMETRY)).toHaveLength(1);
    expect(tags.filter((t) => t === SDK_TELEMETRY)).toHaveLength(1);
  });

  test.each(factories)(
    "%s with enableTelemetry: false adds no agentkit tag",
    async (_name, create) => {
      spyOnFetch();
      const redis = stubbedRedis();
      create(redis, false);
      const tags = await tagsAfter(redis);
      expect(tags.some((t) => t.includes("agentkit"))).toBe(false);
    },
  );
});
