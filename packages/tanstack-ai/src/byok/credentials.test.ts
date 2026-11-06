import { randomBytes } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { storedProviderKeys } from "@tanstack/ai/byok/server";
import { upstashCredentials } from "./credentials.js";
import { cleanupKeys, hasRedisCreds, testRedis, uniquePrefix } from "../testing/test-support.js";

describe.skipIf(!hasRedisCreds)("upstashCredentials (live Redis)", () => {
  const redis = testRedis();
  const prefix = uniquePrefix("cred");
  afterAll(() => cleanupKeys(redis, prefix));

  const key = randomBytes(32).toString("base64");
  const oauth = {
    type: "oauth" as const,
    accessToken: "at-secret",
    refreshToken: "rt-secret",
    expiresAt: 1234,
  };

  it("stores, reads, lists (never a secret) and deletes per owner", async () => {
    const store = upstashCredentials({ redis, prefix: `${prefix}:a` });
    const user = { tenantId: "t1", userId: "u1" };
    await store.set({ scope: user, id: "openai", credential: { type: "api_key", value: "sk-1" } });
    await store.set({ scope: user, id: "github", credential: oauth });
    expect(await store.get({ scope: user, id: "openai" })).toEqual({
      type: "api_key",
      value: "sk-1",
    });
    const listed = await store.list(user);
    expect(listed.sort((a, b) => a.id.localeCompare(b.id))).toEqual([
      { id: "github", type: "oauth", expiresAt: 1234 },
      { id: "openai", type: "api_key" },
    ]);
    expect(JSON.stringify(listed)).not.toContain("secret");
    await store.delete({ scope: user, id: "openai" });
    expect(await store.get({ scope: user, id: "openai" })).toBeNull();
    await store.delete({ scope: user, id: "openai" }); // no-op
  });

  it("keeps user, tenant and shared scopes apart (threadId is ignored)", async () => {
    const store = upstashCredentials({ redis, prefix: `${prefix}:s` });
    const cred = (value: string) => ({ type: "api_key" as const, value });
    await store.set({ scope: { tenantId: "t", userId: "u" }, id: "k", credential: cred("user") });
    await store.set({ scope: { tenantId: "t" }, id: "k", credential: cred("tenant") });
    await store.set({ scope: {}, id: "k", credential: cred("shared") });
    await store.set({ scope: { userId: "" }, id: "k", credential: cred("empty-user") });
    const v = async (scope: object) => ((await store.get({ scope, id: "k" })) as any)?.value;
    expect(await v({ tenantId: "t", userId: "u", threadId: "x" })).toBe("user");
    expect(await v({ tenantId: "t" })).toBe("tenant");
    expect(await v({})).toBe("shared");
    expect(await v({ userId: "" })).toBe("empty-user");
    expect(await v({ userId: "other" })).toBeUndefined();
  });

  it("compare-and-sets on a revision that never comes back after a delete", async () => {
    const store = upstashCredentials({ redis, prefix: `${prefix}:r` });
    const scope = { userId: "u" };
    const a = { type: "api_key" as const, value: "a" };
    expect(await store.setIf!({ scope, id: "x", credential: a, expectedRevision: "1" })).toEqual({
      ok: false,
      reason: "conflict",
    });
    const first = await store.setIf!({ scope, id: "x", credential: a, expectedRevision: null });
    expect(first.ok).toBe(true);
    const rev1 = (first as { revision: string }).revision;
    expect((await store.getVersioned!({ scope, id: "x" }))?.revision).toBe(rev1);
    // A stale second writer loses; the winner's revision moves on.
    const b = { type: "api_key" as const, value: "b" };
    const second = await store.setIf!({ scope, id: "x", credential: b, expectedRevision: rev1 });
    expect(second.ok).toBe(true);
    expect(await store.setIf!({ scope, id: "x", credential: a, expectedRevision: rev1 })).toEqual({
      ok: false,
      reason: "conflict",
    });
    // A plain set also gives a new revision; a delete + re-create never reuses one.
    await store.delete({ scope, id: "x" });
    expect(await store.getVersioned!({ scope, id: "x" })).toBeNull();
    await store.set({ scope, id: "x", credential: a });
    const again = (await store.getVersioned!({ scope, id: "x" }))!.revision;
    expect([rev1, (second as { revision: string }).revision]).not.toContain(again);
  });

  it("exactly one of many concurrent setIf writers wins", async () => {
    const store = upstashCredentials({ redis, prefix: `${prefix}:c` });
    const scope = { userId: "u" };
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        store.setIf!({
          scope,
          id: "race",
          credential: { type: "api_key", value: String(i) },
          expectedRevision: null,
        }),
      ),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
  });

  it("encrypts secrets at rest, bound to owner and id, and reads old plaintext rows", async () => {
    const p = `${prefix}:e`;
    const plain = upstashCredentials({ redis, prefix: p });
    const enc = upstashCredentials({ redis, prefix: p, encryptionKey: key });
    const scope = { tenantId: "t", userId: "u" };
    await plain.set({ scope, id: "old", credential: { type: "api_key", value: "plain-secret" } });
    await enc.set({ scope, id: "new", credential: oauth });

    expect(await enc.get({ scope, id: "new" })).toEqual(oauth);
    expect(await enc.get({ scope, id: "old" })).toEqual({ type: "api_key", value: "plain-secret" });
    expect((await enc.list(scope)).find((c) => c.id === "new")).toEqual({
      id: "new",
      type: "oauth",
      expiresAt: 1234,
    });

    const raw = JSON.stringify(await redis.hgetall(`${p}:credentials:t:u`));
    expect(raw).toContain("plain-secret"); // written before a key existed
    expect(raw).not.toContain("at-secret");
    expect(raw).not.toContain("rt-secret");

    await expect(plain.get({ scope, id: "new" })).rejects.toThrow(/encrypted/);
    const other = upstashCredentials({
      redis,
      prefix: p,
      encryptionKey: randomBytes(32).toString("base64"),
    });
    await expect(other.get({ scope, id: "new" })).rejects.toThrow();

    // Ciphertext copied to another id (or owner) must not decrypt.
    const stolen = await redis.hget(`${p}:credentials:t:u`, "new");
    await redis.hset(`${p}:credentials:t:u`, { moved: stolen as never });
    await expect(enc.get({ scope, id: "moved" })).rejects.toThrow();
  });

  it("rejects a bad encryption key and a bad id", async () => {
    expect(() => upstashCredentials({ redis, encryptionKey: "c2hvcnQ=" })).toThrow(/32 bytes/);
    const store = upstashCredentials({ redis, prefix: `${prefix}:v` });
    await expect(store.get({ scope: {}, id: "" })).rejects.toThrow(/non-empty/);
  });

  it("drives TanStack's storedProviderKeys: the user's key, else the tenant's", async () => {
    const store = upstashCredentials({ redis, prefix: `${prefix}:p`, encryptionKey: key });
    await store.set({
      scope: { tenantId: "t" },
      id: "openai",
      credential: { type: "api_key", value: "tenant-key" },
    });
    expect(await storedProviderKeys(store, { tenantId: "t", userId: "u" }).get("openai")).toBe(
      "tenant-key",
    );
    await store.set({
      scope: { tenantId: "t", userId: "u" },
      id: "openai",
      credential: { type: "api_key", value: "user-key" },
    });
    expect(await storedProviderKeys(store, { tenantId: "t", userId: "u" }).get("openai")).toBe(
      "user-key",
    );
  });

  it("requireEncryption refuses a plaintext row swapped in for an encrypted one", async () => {
    const p = `${prefix}:rq`;
    const store = upstashCredentials({
      redis,
      prefix: p,
      encryptionKey: key,
      requireEncryption: true,
    });
    const scope = { userId: "u" };
    await store.set({ scope, id: "openai", credential: { type: "api_key", value: "real" } });
    expect(await store.get({ scope, id: "openai" })).toEqual({ type: "api_key", value: "real" });
    await redis.hset(`${p}:credentials:%none:u`, {
      openai: '{"r":1,"t":"api_key","c":{"type":"api_key","value":"ATTACKER"}}',
    });
    await expect(store.get({ scope, id: "openai" })).rejects.toThrow(/requireEncryption/);
    expect(() => upstashCredentials({ redis, requireEncryption: true })).toThrow(/needs an/);
  });

  it("authenticates the clear-text type and expiry that list shows", async () => {
    const p = `${prefix}:aad`;
    const store = upstashCredentials({ redis, prefix: p, encryptionKey: key });
    const scope = { userId: "u" };
    await store.set({ scope, id: "gh", credential: oauth });
    const hash = `${p}:credentials:%none:u`;
    const row = (await redis.hget<Record<string, unknown>>(hash, "gh"))!;
    await redis.hset(hash, { gh: JSON.stringify({ ...row, x: 9999999999999 }) });
    await expect(store.get({ scope, id: "gh" })).rejects.toThrow();
  });

  it("stores a large encrypted credential, and accepts base64url and hex keys", async () => {
    const big = { type: "api_key" as const, value: "k".repeat(400_000) };
    const store = upstashCredentials({ redis, prefix: `${prefix}:big`, encryptionKey: key });
    await store.set({ scope: { userId: "u" }, id: "big", credential: big });
    expect(await store.get({ scope: { userId: "u" }, id: "big" })).toEqual(big);
    const raw = randomBytes(32);
    const forms = [raw.toString("base64"), raw.toString("base64url"), raw.toString("hex"), raw];
    const first = upstashCredentials({ redis, prefix: `${prefix}:keys`, encryptionKey: forms[0]! });
    await first.set({ scope: {}, id: "k", credential: { type: "api_key", value: "v" } });
    for (const form of forms.slice(1)) {
      const other = upstashCredentials({ redis, prefix: `${prefix}:keys`, encryptionKey: form });
      expect(await other.get({ scope: {}, id: "k" })).toEqual({ type: "api_key", value: "v" });
    }
    expect(() => upstashCredentials({ redis, encryptionKey: "not a key!" })).toThrow(/32 bytes/);
    expect(() => upstashCredentials({ redis, encryptionKey: "a".repeat(32) })).toThrow(/32 bytes/);
  });

  it("rejects the reserved id __proto__", async () => {
    const store = upstashCredentials({ redis, prefix: `${prefix}:pr` });
    await expect(
      store.set({ scope: {}, id: "__proto__", credential: { type: "api_key", value: "x" } }),
    ).rejects.toThrow(/__proto__/);
  });
});
