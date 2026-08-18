import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { SDK_TELEMETRY } from "@upstash/agentkit-sdk";
import { Redis } from "@upstash/redis";
import type * as Runtime from "../extension/lib/runtime";

/**
 * The extension's redis client is built lazily inside `lib/runtime.ts` from the **mount config**, so
 * this test binds config the way eve's runtime does — a string scope on `globalThis` while the
 * extension module is evaluated, then the mount factory called with the config. Everything after
 * that is the same wire-level check as the other packages: the Upstash client calls the global
 * `fetch`, so stubbing it captures the headers actually sent.
 */
const EXT_CONFIG_SCOPE = Symbol.for("eve.ext-config-scope");

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
const stubbedRedis = (): Redis =>
  new Redis({
    url: "https://telemetry.test.upstash.io",
    token: "test-token",
    responseEncoding: false,
    retry: false,
    enableAutoPipelining: false,
  });

const telemetryHeader = (): string[] =>
  (sent[0]?.["Upstash-Telemetry-Sdk"] ?? "").split(",").filter(Boolean);

describe("outgoing request headers", () => {
  const redis = stubbedRedis();
  let runtime: typeof Runtime;
  let version: string;

  beforeAll(async () => {
    (globalThis as Record<symbol, unknown>)[EXT_CONFIG_SCOPE] = "agentkit";
    const mount = (await import("../extension/extension")).default;
    mount({ userId: "user-1", redis });
    (globalThis as Record<symbol, unknown>)[EXT_CONFIG_SCOPE] = undefined;

    runtime = await import("../extension/lib/runtime");
    version = (await import("../extension/lib/version")).VERSION;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("a command carries both the extension and the core tag", async () => {
    spyOnFetch();
    // Touching the memory store is what builds the client and the core primitive on top of it.
    runtime.memory();

    await redis.set("agentkit:telemetry-test", "value");

    expect(sent.length).toBe(1);
    expect(telemetryHeader()).toContain(`@upstash/agentkit-eve-extension@${version}`);
    expect(telemetryHeader()).toContain(SDK_TELEMETRY);
    expect(telemetryHeader()[0]).toMatch(/^@upstash\/redis@/);
  });

  test("each tag is added only once, however many contributions run", async () => {
    spyOnFetch();
    runtime.memory();
    runtime.memory();
    runtime.redis();

    await redis.set("agentkit:telemetry-test", "value");

    const extensionTag = `@upstash/agentkit-eve-extension@${version}`;
    expect(telemetryHeader().filter((tag) => tag === extensionTag).length).toBe(1);
    expect(telemetryHeader().filter((tag) => tag === SDK_TELEMETRY).length).toBe(1);
  });
});
