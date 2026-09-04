/**
 * The Redis backend under the DeepSeek Harness's own conformance suite, plus the
 * Redis-specific behaviour the shared contract does not reach: key layout, store
 * identity, seek reads, atomic append, out-of-band tail repair, and TTL.
 *
 * Runs against a real Upstash Redis (project policy: no Redis mocks).
 */
import { afterAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import SessionStore, { SessionId } from "@deepseek-ai/dsh-session";
import LocalCredentialProvider from "@deepseek-ai/dsh-credentials-local";
import { RedisSessionPersistence } from "../src/session-persistence.js";
import { sessionKeys } from "../src/keys.js";
import { scanRecords } from "../src/records.js";
import { parseArgs } from "../src/cli.js";
import { cleanupKeys, hasRedisCreds, testRedis, uniquePrefix } from "../src/test-support.js";
import { runPersistenceContract, meta, oneTurnLog } from "./contract.js";

const prefixes: string[] = [];

/** A fresh, empty backend on its own key prefix — the contract's `make()`. */
async function makeBackend() {
  const prefix = uniquePrefix("dsh");
  prefixes.push(prefix);
  const ctx = new Context();
  await ctx.plugin(SessionStore);
  const fiber = await ctx.plugin(RedisSessionPersistence, { redis: testRedis(), prefix });
  return {
    ctx,
    prefix,
    persistence: ctx.sessionPersistence,
    backend: ctx.sessionPersistence as RedisSessionPersistence,
    dispose: async () => {
      await fiber.dispose();
    },
  };
}

afterAll(async () => {
  if (!hasRedisCreds) return;
  const redis = testRedis();
  for (const prefix of prefixes.splice(0)) await cleanupKeys(redis, prefix);
}, 120_000);

describe.skipIf(!hasRedisCreds)("RedisSessionPersistence", () => {
  // The backend-agnostic suite the first-party JSONL and SQLite backends pass.
  // Passing it unchanged is what makes this a drop-in replacement rather than a
  // lookalike.
  runPersistenceContract("upstash-redis", async () => {
    const { persistence, dispose } = await makeBackend();
    return { persistence, dispose };
  });

  it("has no per-session artifact, so it neither locates nor exposes raw text", async () => {
    const { backend, dispose } = await makeBackend();
    try {
      expect(backend.supportsRawArtifacts).toBe(false);
      expect(backend.locate(meta("no-artifact"))).toBeUndefined();
      await expect(backend.readRaw(SessionId("no-artifact"))).rejects.toThrow(/raw artifacts/);
    } finally {
      await dispose();
    }
  });

  it("stores the log as a list whose index is the event seq", async () => {
    const { backend, prefix, dispose } = await makeBackend();
    try {
      const m = meta("layout");
      const log = oneTurnLog();
      await backend.create(m);
      await backend.append(m.id, log);

      const redis = testRedis();
      const keys = sessionKeys(prefix);
      // The seek read (`LRANGE key fromSeq -1`) is only correct because index === seq.
      expect(await redis.llen(keys.events(m.id))).toBe(log.length);
      const stored = await redis.lrange<{ seq: number; type: string }>(keys.events(m.id), 0, -1);
      expect(stored.map((event) => event.seq)).toEqual([0, 1, 2, 3, 4, 5]);
      expect(stored[3]?.type).toBe("assistant/message");

      // Metadata is out-of-log, and the id set is what `list` reads.
      const stored_meta = await redis.hgetall<Record<string, unknown>>(keys.meta(m.id));
      expect(stored_meta?.["revision"]).toBe(1);
      expect(stored_meta?.["incarnation"]).toEqual(expect.any(String));
      expect(await redis.smembers(keys.ids)).toContain(String(m.id));
    } finally {
      await dispose();
    }
  });

  it("reads only the requested suffix instead of the whole log", async () => {
    const { backend, dispose } = await makeBackend();
    try {
      const m = meta("seek");
      await backend.create(m);
      await backend.append(m.id, oneTurnLog());

      // `loadStoredFrom` is the optional seek hook; implementing it is what keeps
      // `readFrom` proportional to the suffix rather than the log.
      const suffix = await backend.loadStoredFrom(m.id, 4);
      expect(suffix?.events.map((event) => event.seq)).toEqual([4, 5]);
      expect(suffix?.meta.id).toBe(m.id);
      await expect(backend.loadStoredFrom(SessionId("absent"), 0)).resolves.toBeUndefined();
    } finally {
      await dispose();
    }
  });

  it("qualifies revisions by store, so two prefixes never compare equal", async () => {
    const first = await makeBackend();
    const second = await makeBackend();
    try {
      const m = meta("revision-identity");
      for (const fixture of [first, second]) {
        await fixture.backend.create(m);
        await fixture.backend.append(m.id, oneTurnLog());
      }
      const a = await first.backend.readStoredRevision(m.id);
      const b = await second.backend.readStoredRevision(m.id);
      // Same session id, same local counter, different stores.
      expect(a).toBeDefined();
      expect(a).not.toBe(b);

      // A revision is stable while the log is unchanged, and moves after a write.
      expect(await first.backend.readStoredRevision(m.id)).toBe(a);
      await first.backend.append(m.id, [
        { type: "turn/start", seq: 6, time: 7, data: { turn: 2 } },
      ]);
      expect(await first.backend.readStoredRevision(m.id)).not.toBe(a);
      await expect(first.backend.readStoredRevision(SessionId("absent"))).resolves.toBeUndefined();
    } finally {
      await first.dispose();
      await second.dispose();
    }
  });

  it("rejects a batch that does not continue the stored log, without partially writing it", async () => {
    const { backend, prefix, dispose } = await makeBackend();
    try {
      const m = meta("atomic-append");
      await backend.create(m);
      await backend.append(m.id, oneTurnLog());

      // Straight at the storage hook: the coordinator's in-memory next-seq is
      // bypassed, so this is the Lua guard rejecting a second writer.
      await expect(
        backend.appendBatch(m, [{ type: "turn/start", seq: 99, time: 1, data: { turn: 9 } }], true),
      ).rejects.toThrow(/AGENTKIT_SEQ_MISMATCH/);

      const redis = testRedis();
      expect(await redis.llen(sessionKeys(prefix).events(m.id))).toBe(6);
    } finally {
      await dispose();
    }
  });

  it("repairs a tail damaged outside the backend", async () => {
    const { backend, prefix, dispose } = await makeBackend();
    try {
      const m = meta("torn");
      await backend.create(m);
      await backend.append(m.id, oneTurnLog());

      // This backend cannot produce a torn tail — every mutation is one atomic
      // script — so the marker path is only reachable by damaging the key
      // directly, which is exactly what makes it worth keeping implemented.
      const redis = testRedis();
      const keys = sessionKeys(prefix);
      await redis.rpush(keys.events(m.id), "{not valid json");

      const prefixRead = await backend.loadStored(m.id);
      expect(prefixRead?.tornMarker).toBe(6);
      expect(prefixRead?.events).toHaveLength(6);

      await backend.commitRepair(m, prefixRead?.tornMarker, []);
      expect(await redis.llen(keys.events(m.id))).toBe(6);
      expect((await backend.loadStored(m.id))?.tornMarker).toBeUndefined();
    } finally {
      await dispose();
    }
  });

  it("expires stored sessions when a ttl is configured, and drops their stale ids", async () => {
    const prefix = uniquePrefix("dsh-ttl");
    prefixes.push(prefix);
    const ctx = new Context();
    await ctx.plugin(SessionStore);
    const fiber = await ctx.plugin(RedisSessionPersistence, {
      redis: testRedis(),
      prefix,
      ttlSeconds: 60,
    });
    const backend = ctx.sessionPersistence as RedisSessionPersistence;
    try {
      const m = meta("ttl");
      await backend.create(m);
      await backend.append(m.id, oneTurnLog());

      const redis = testRedis();
      const keys = sessionKeys(prefix);
      expect(await redis.ttl(keys.events(m.id))).toBeGreaterThan(0);
      expect(await redis.ttl(keys.meta(m.id))).toBeGreaterThan(0);
      // Store identity outlives any single session.
      expect(await redis.ttl(keys.store)).toBe(-1);

      // Simulate the expiry the TTL will eventually cause: listing must not
      // surface a session whose keys are gone, and must forget its id.
      await redis.del(keys.meta(m.id), keys.events(m.id));
      expect(await backend.listSnapshots()).toEqual([]);
      expect(await redis.smembers(keys.ids)).toEqual([]);
    } finally {
      await fiber.dispose();
    }
  });
});

describe.skipIf(!hasRedisCreds)("credential resolution", () => {
  // Refs the environment does not carry. That matters twice: the provider
  // refuses to write a ref the launching shell already supplies, and using
  // absent names proves the connection came from the credentials document
  // rather than falling through to `Redis.fromEnv()`.
  const URL_REF = "AGENTKIT_TEST_UPSTASH_URL";
  const TOKEN_REF = "AGENTKIT_TEST_UPSTASH_TOKEN";

  it("connects using credentials the harness stored, not the environment", async () => {
    const home = await mkdtemp(join(tmpdir(), "agentkit-dsh-"));
    const prefix = uniquePrefix("dsh-cred");
    prefixes.push(prefix);
    const ctx = new Context();
    await ctx.plugin(SessionStore);
    await ctx.plugin(LocalCredentialProvider, { dshHome: home });

    const credentials = ctx.get("credentials") as {
      set(ref: string, value: string): Promise<void>;
    };
    await credentials.set(URL_REF, process.env.UPSTASH_REDIS_REST_URL as string);
    await credentials.set(TOKEN_REF, process.env.UPSTASH_REDIS_REST_TOKEN as string);

    // No `redis` in config, and these refs are absent from the environment — so
    // a working round trip can only mean `ctx.credentials` supplied the client.
    const fiber = await ctx.plugin(RedisSessionPersistence, {
      prefix,
      urlRef: URL_REF,
      tokenRef: TOKEN_REF,
    });
    try {
      const backend = ctx.sessionPersistence as RedisSessionPersistence;
      const m = meta("via-credentials");
      await backend.create(m);
      await backend.append(m.id, oneTurnLog());
      expect((await backend.load(m.id)).events).toHaveLength(6);
    } finally {
      await fiber.dispose();
      await rm(home, { recursive: true, force: true });
    }
  });

  it("falls back to the environment when no credentials provider is mounted", async () => {
    const prefix = uniquePrefix("dsh-env");
    prefixes.push(prefix);
    const ctx = new Context();
    await ctx.plugin(SessionStore);
    // No credentials provider and no `redis` in config: `Redis.fromEnv()` is the
    // only remaining source, which is how an embedder outside dsh runs this.
    const fiber = await ctx.plugin(RedisSessionPersistence, { prefix });
    try {
      const backend = ctx.sessionPersistence as RedisSessionPersistence;
      const m = meta("via-env");
      await backend.create(m);
      await backend.append(m.id, oneTurnLog());
      expect((await backend.load(m.id)).events).toHaveLength(6);
    } finally {
      await fiber.dispose();
    }
  });
});

describe("cli argument parsing", () => {
  it("accepts the command with or without the `credentials` noun", () => {
    expect(parseArgs(["credentials", "status"]).command).toBe("status");
    expect(parseArgs(["status"]).command).toBe("status");
  });

  it("defaults the refs and overrides them from flags", () => {
    expect(parseArgs(["set"]).urlRef).toBe("UPSTASH_REDIS_REST_URL");
    expect(parseArgs(["set", "--url-ref", "MY_URL"]).urlRef).toBe("MY_URL");
  });

  it("reads values and treats a bare command as help", () => {
    const args = parseArgs(["credentials", "set", "--url", "https://x", "--token", "t"]);
    expect(args).toMatchObject({ command: "set", url: "https://x", token: "t" });
    expect(parseArgs([]).command).toBe("help");
    expect(parseArgs(["--help"]).command).toBe("help");
  });

  it("rejects unknown commands, unknown flags, and value-less flags", () => {
    expect(() => parseArgs(["bogus"])).toThrow(/unknown command/);
    expect(() => parseArgs(["set", "--nope"])).toThrow(/unknown option/);
    expect(() => parseArgs(["set", "--url"])).toThrow(/requires a value/);
    expect(() => parseArgs(["set", "--url-ref", "1bad"])).toThrow(/must match/);
  });
});

describe("scanRecords", () => {
  const turnEnd = {
    type: "turn/end",
    seq: 1,
    time: 2,
    data: { turn: 1, reason: { kind: "completed" } },
  };

  it("accepts records that arrive parsed or as raw JSON text", () => {
    // `@upstash/redis` deserializes responses by default, so both shapes are real.
    const parsed = scanRecords([{ type: "turn/start", seq: 0, time: 1, data: {} }, turnEnd]);
    const raw = scanRecords([
      JSON.stringify({ type: "turn/start", seq: 0, time: 1, data: {} }),
      JSON.stringify(turnEnd),
    ]);
    expect(parsed.preserved).toHaveLength(2);
    expect(raw.preserved).toHaveLength(2);
    expect(parsed.tornFrom).toBeUndefined();
  });

  it("tolerates a hole after the last turn/end and reports it as the truncation point", () => {
    const { preserved, tornFrom } = scanRecords([
      { type: "turn/start", seq: 0, time: 1, data: {} },
      turnEnd,
      "{not valid json",
    ]);
    expect(preserved).toHaveLength(2);
    expect(tornFrom).toBe(2);
  });

  it("rejects a hole inside the committed region", () => {
    expect(() =>
      scanRecords([{ type: "turn/start", seq: 0, time: 1, data: {} }, "{torn", turnEnd]),
    ).toThrow(/committed/);
  });

  it("bases a suffix scan at the requested seq", () => {
    const { preserved, tornFrom } = scanRecords([{ ...turnEnd, seq: 4 }], 4);
    expect(preserved.map((event) => event.seq)).toEqual([4]);
    expect(tornFrom).toBeUndefined();
  });
});
