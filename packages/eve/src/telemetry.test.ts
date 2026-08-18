import { afterEach, describe, expect, test } from "vitest";
import { SDK_TELEMETRY } from "@upstash/agentkit-sdk";
import { Redis, s } from "@upstash/redis";
import { defineMemoryRecallTool } from "./memory.js";
import { EVE_TELEMETRY } from "./telemetry.js";
import { VERSION } from "./version.js";

/**
 * The Upstash client calls the global `fetch`, so stubbing it captures the headers actually put on
 * the wire (no credentials and no network needed).
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

  test("reports this package's name and version", () => {
    expect(EVE_TELEMETRY).toBe(`@upstash/agentkit-eve@${VERSION}`);
  });

  test("a command carries both the adapter and the core tag", async () => {
    spyOnFetch();
    const redis = stubbedRedis();
    defineMemoryRecallTool({ userId: "user-1", redis });

    await redis.set("agentkit:telemetry-test", "value");

    expect(sent.length).toBe(1);
    expect(telemetryHeader()).toContain(EVE_TELEMETRY);
    expect(telemetryHeader()).toContain(SDK_TELEMETRY);
    expect(telemetryHeader()[0]).toMatch(/^@upstash\/redis@/);
  });

  test("search tools tag the client too", async () => {
    spyOnFetch();
    const redis = stubbedRedis();
    // Imported lazily so this file's other tests don't pay for the schema build.
    const { defineSearchTools } = await import("./search-tools.js");
    defineSearchTools({ redis, schema: s.object({ title: s.string() }), indexName: "tel_test" });

    await redis.set("agentkit:telemetry-test", "value");

    expect(telemetryHeader()).toContain(EVE_TELEMETRY);
    expect(telemetryHeader()).toContain(SDK_TELEMETRY);
  });

  test("enableTelemetry: false keeps every agentkit tag off the request", async () => {
    spyOnFetch();
    const redis = stubbedRedis();
    defineMemoryRecallTool({ userId: "user-1", redis, enableTelemetry: false });

    await redis.set("agentkit:telemetry-test", "value");

    expect(sent.length).toBe(1);
    expect(telemetryHeader().some((tag) => tag.includes("agentkit"))).toBe(false);
  });
});
