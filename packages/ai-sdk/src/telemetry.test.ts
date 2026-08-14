import { tool } from "ai";
import { z } from "zod";
import { afterEach, describe, expect, test } from "vitest";
import { SDK_TELEMETRY } from "@upstash/agentkit-sdk";
import { Redis } from "@upstash/redis";
import { cachedTools } from "./tools.js";
import { createMemoryTools } from "./memory.js";
import { AI_SDK_TELEMETRY, addTelemetry } from "./telemetry.js";
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

describe("telemetry", () => {
  test("reports this package's name and version", () => {
    const { client, calls } = createRedisMock();
    addTelemetry(client);

    expect(AI_SDK_TELEMETRY).toBe(`@upstash/agentkit-ai-sdk@${VERSION}`);
    expect(calls).toEqual([{ sdk: AI_SDK_TELEMETRY }]);
  });

  test("cachedTools tags the client with both the adapter and the core sdk", () => {
    const { client, calls } = createRedisMock();
    cachedTools(
      {
        getWeather: tool({
          description: "Get the weather for a city",
          inputSchema: z.object({ city: z.string() }),
          execute: async ({ city }) => ({ city, temperature: 21 }),
        }),
      },
      { userId: "user-1", redis: client as never },
    );

    expect(calls.map((c) => c.sdk)).toEqual([AI_SDK_TELEMETRY, SDK_TELEMETRY]);
  });

  test("createMemoryTools respects enableTelemetry: false", () => {
    const { client, calls } = createRedisMock();
    createMemoryTools({ userId: "user-1", redis: client as never, enableTelemetry: false });

    expect(calls.length).toBe(0);
  });
});

/**
 * Proof the tags ride on the wire, not just that the client was told about them: the Upstash client
 * calls the global `fetch`, so stubbing it captures the real outgoing request headers.
 */
describe("outgoing request headers", () => {
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

  const telemetryHeader = (): string[] =>
    (sent[0]?.["Upstash-Telemetry-Sdk"] ?? "").split(",").filter(Boolean);

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("a command carries both the adapter and the core tag", async () => {
    spyOnFetch();
    const redis = stubbedRedis();
    createMemoryTools({ userId: "user-1", redis });

    await redis.set("agentkit:telemetry-test", "value");

    expect(sent.length).toBe(1);
    expect(telemetryHeader()).toContain(AI_SDK_TELEMETRY);
    expect(telemetryHeader()).toContain(SDK_TELEMETRY);
    expect(telemetryHeader()[0]).toMatch(/^@upstash\/redis@/);
  });

  test("enableTelemetry: false keeps every agentkit tag off the request", async () => {
    spyOnFetch();
    const redis = stubbedRedis();
    createMemoryTools({ userId: "user-1", redis, enableTelemetry: false });

    await redis.set("agentkit:telemetry-test", "value");

    expect(sent.length).toBe(1);
    expect(telemetryHeader().some((tag) => tag.includes("agentkit"))).toBe(false);
  });
});
