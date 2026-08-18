import { afterEach, describe, expect, test } from "vitest";
import { Redis } from "@upstash/redis";
import { ChatHistory } from "./chat-history.js";
import { AgentMemory } from "./memory.js";
import { addTelemetry, SDK_TELEMETRY } from "./telemetry.js";
import { hasRedisCreds, testRedis, uniquePrefix } from "./test-support.js";
import { ToolCache } from "./tool-cache.js";
import { VERSION } from "./version.js";

/** A stand-in for the redis client: only `addTelemetry` (+ `search.index`) is exercised here. */
const createRedisMock = () => {
  const calls: { sdk?: string }[] = [];
  return {
    calls,
    client: {
      addTelemetry: (telemetry: { sdk?: string }) => {
        calls.push(telemetry);
      },
      search: { index: () => ({}) },
    },
  };
};

describe("addTelemetry", () => {
  afterEach(() => {
    delete process.env.UPSTASH_DISABLE_TELEMETRY;
  });

  test("sends the sdk name and version", () => {
    const { client, calls } = createRedisMock();
    addTelemetry(client);

    expect(calls).toEqual([{ sdk: `@upstash/agentkit-sdk@${VERSION}` }]);
    expect(SDK_TELEMETRY).toBe(`@upstash/agentkit-sdk@${VERSION}`);
  });

  test("tags a client only once per sdk", () => {
    const { client, calls } = createRedisMock();
    addTelemetry(client);
    addTelemetry(client);

    expect(calls.length).toBe(1);
  });

  test("tags the same client once per distinct sdk (core + adapter layers)", () => {
    const { client, calls } = createRedisMock();
    addTelemetry(client);
    addTelemetry(client, { sdk: "@upstash/agentkit-ai-sdk@1.2.3" });
    addTelemetry(client, { sdk: "@upstash/agentkit-ai-sdk@1.2.3" });

    expect(calls).toEqual([{ sdk: SDK_TELEMETRY }, { sdk: "@upstash/agentkit-ai-sdk@1.2.3" }]);
  });

  test("respects enabled: false", () => {
    const { client, calls } = createRedisMock();
    addTelemetry(client, { enabled: false });

    expect(calls.length).toBe(0);
  });

  test("respects UPSTASH_DISABLE_TELEMETRY", () => {
    process.env.UPSTASH_DISABLE_TELEMETRY = "1";
    const { client, calls } = createRedisMock();
    addTelemetry(client);

    expect(calls.length).toBe(0);
  });

  test("does not throw on clients without addTelemetry", () => {
    expect(() => addTelemetry({})).not.toThrow();
    expect(() => addTelemetry(undefined)).not.toThrow();
  });

  test("does not throw when addTelemetry throws", () => {
    const client = {
      addTelemetry: () => {
        throw new Error("boom");
      },
    };

    expect(() => addTelemetry(client)).not.toThrow();
  });
});

describe("feature wiring", () => {
  test("ToolCache tags its redis client", () => {
    const { client, calls } = createRedisMock();
    new ToolCache({ redis: client as never });

    expect(calls).toEqual([{ sdk: SDK_TELEMETRY }]);
  });

  test("ToolCache respects enableTelemetry: false", () => {
    const { client, calls } = createRedisMock();
    new ToolCache({ redis: client as never, enableTelemetry: false });

    expect(calls.length).toBe(0);
  });

  test("AgentMemory tags its redis client once (not again via its search index)", () => {
    const { client, calls } = createRedisMock();
    new AgentMemory({ redis: client as never });

    expect(calls).toEqual([{ sdk: SDK_TELEMETRY }]);
  });

  test("AgentMemory respects enableTelemetry: false", () => {
    const { client, calls } = createRedisMock();
    new AgentMemory({ redis: client as never, enableTelemetry: false });

    expect(calls.length).toBe(0);
  });
});

/**
 * The tests above prove the client was *told* about the sdk. These prove the tag actually rides on
 * the wire: the Upstash client calls the global `fetch`, so stubbing it captures the real outgoing
 * request headers (no credentials and no network needed).
 */
describe("outgoing request headers", () => {
  const realFetch = globalThis.fetch;
  let sent: Record<string, string>[] = [];

  /** Swap in a fetch that records request headers and replies like the Upstash REST API. */
  function spyOnFetch(): void {
    sent = [];
    globalThis.fetch = (async (_url: unknown, init?: { headers?: Record<string, string> }) => {
      sent.push({ ...init?.headers });
      return new Response(JSON.stringify({ result: "OK" }), { status: 200 });
    }) as unknown as typeof fetch;
  }

  /**
   * A client pointed at nowhere — every request is served by the fetch stub above. Auto-pipelining
   * is off so one command is one request with one (non-array) response body to fake.
   */
  function stubbedRedis(): Redis {
    return new Redis({
      url: "https://telemetry.test.upstash.io",
      token: "test-token",
      responseEncoding: false,
      retry: false,
      enableAutoPipelining: false,
    });
  }

  const telemetryHeader = (): string[] =>
    (sent[0]?.["Upstash-Telemetry-Sdk"] ?? "").split(",").filter(Boolean);

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("a command carries the sdk tag alongside the redis client's own", async () => {
    spyOnFetch();
    const redis = stubbedRedis();
    new AgentMemory({ redis });

    await redis.set("agentkit:telemetry-test", "value");

    expect(sent.length).toBe(1);
    expect(telemetryHeader()).toContain(SDK_TELEMETRY);
    // The redis client tags itself first; ours is appended, never replacing it.
    expect(telemetryHeader()[0]).toMatch(/^@upstash\/redis@/);
  });

  test("every feature on one client contributes exactly one tag", async () => {
    spyOnFetch();
    const redis = stubbedRedis();
    new AgentMemory({ redis });
    new ToolCache({ redis });
    new ChatHistory({ redis });

    await redis.set("agentkit:telemetry-test", "value");

    expect(telemetryHeader().filter((tag) => tag === SDK_TELEMETRY).length).toBe(1);
  });

  test("enableTelemetry: false keeps the tag off the request", async () => {
    spyOnFetch();
    const redis = stubbedRedis();
    new AgentMemory({ redis, enableTelemetry: false });

    await redis.set("agentkit:telemetry-test", "value");

    expect(sent.length).toBe(1);
    expect(telemetryHeader()).not.toContain(SDK_TELEMETRY);
    expect(telemetryHeader().some((tag) => tag.includes("agentkit"))).toBe(false);
  });
});

/** The header must also be accepted by the real API — a tagged client still executes commands. */
describe.skipIf(!hasRedisCreds)("outgoing request headers (live Redis)", () => {
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("a real command is sent with the tag and still succeeds", async () => {
    const sent: string[] = [];
    globalThis.fetch = ((url: never, init?: { headers?: Record<string, string> }) => {
      const header = init?.headers?.["Upstash-Telemetry-Sdk"];
      if (header) sent.push(header);
      return realFetch(url, init as never);
    }) as unknown as typeof fetch;

    const redis = testRedis();
    const key = `${uniquePrefix("telemetry")}:probe`;
    new AgentMemory({ redis });

    await redis.set(key, "ok", { ex: 30 });
    const value = await redis.get(key);
    await redis.del(key);

    expect(value).toBe("ok");
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.every((header) => header.split(",").includes(SDK_TELEMETRY))).toBe(true);
  });
});
