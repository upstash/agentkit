import type { Redis } from "@upstash/redis";
import { Redis as RedisClient } from "@upstash/redis";
import type { Credential, CredentialScope, CredentialStore } from "@tanstack/ai/byok";
import { addTelemetry } from "../telemetry.js";
import { KEY_LOCKING, assertId } from "../persistence/records.js";
import { secretBox } from "../secret-box.js";

export interface UpstashCredentialsConfig {
  /** Upstash Redis client. Defaults to `Redis.fromEnv()`. */
  redis?: Redis;
  /** Base key prefix. Defaults to `agentkit:tanstack`. */
  prefix?: string;
  /**
   * Encrypt the secret part of every credential at rest with AES-256-GCM. A 32-byte key as a
   * `Uint8Array`, or as a base64 / base64url / hex string (`openssl rand -base64 32`). Strongly
   * recommended: without it the secrets sit in Redis as plain JSON.
   *
   * The ciphertext is bound to the key prefix (`prefix`), the owner, the credential id, its type and
   * its expiry: moving rows to another prefix, or editing the clear-text type/expiry, makes them
   * undecryptable. Credentials written before you added a key stay readable (as plaintext) unless
   * you set `requireEncryption`. Not bound: the revision, so someone with write access to your
   * Redis can replay an older ciphertext of the same credential.
   */
  encryptionKey?: string | Uint8Array;
  /**
   * Refuse plaintext rows once an `encryptionKey` is set: a row without ciphertext throws instead of
   * being returned. Without it, anyone who can write to your Redis can swap an encrypted credential
   * for a plaintext one. Turn it on after your existing credentials are re-saved with the key.
   * Needs `encryptionKey`.
   * @default false
   */
  requireEncryption?: boolean;
  /**
   * Report the sdk name + version to Upstash as a header on the requests made by your redis client.
   * Can also be disabled with the `UPSTASH_DISABLE_TELEMETRY` env var. Defaults to `true`.
   */
  enableTelemetry?: boolean;
}

/**
 * Write a credential into its owner's hash, optionally compare-and-set on the revision. The stored
 * value is `{"r":<revision>,<rest>`; the revision comes from a counter that only grows, so a
 * revision never comes back after a `delete`.
 * KEYS: owner hash, revision counter. ARGV: credential id, the JSON object text after `{"r":N,`,
 * "1" to compare, expected revision ("" = absent). Returns the new revision, or -1 on a conflict.
 */
const SET = `${KEY_LOCKING}if ARGV[3] == "1" then
  local cur = redis.call("HGET", KEYS[1], ARGV[1])
  local r = ""
  if cur then r = string.match(cur, '^{"r":(%d+),') or "" end
  if r ~= ARGV[4] then return -1 end
end
local rev = redis.call("INCR", KEYS[2])
redis.call("HSET", KEYS[1], ARGV[1], '{"r":' .. rev .. ',' .. ARGV[2])
return rev`;

/** What is stored per credential. `t`/`x` stay in the clear so `list` never decrypts. */
interface Stored {
  r: number;
  t: Credential["type"];
  x?: number;
  /** The credential, when not encrypted. */
  c?: Credential;
  /** Base64 AES-GCM IV and ciphertext of the credential JSON, when encrypted. */
  iv?: string;
  ct?: string;
}

/** A segment no encoded id can equal: `encodeURIComponent` never emits a bare "%n". */
const NONE = "%none";
const seg = (v: string | undefined) => (v === undefined ? NONE : encodeURIComponent(v));

/**
 * `CredentialStore` (TanStack AI's BYOK contract, `@tanstack/ai/byok`) on Upstash Redis: provider
 * API keys and OAuth tokens a user or a tenant saved, for `storedProviderKeys()` and connectors.
 *
 * One hash per owner (`tenantId` + `userId`; an owner with neither is one shared bucket), one field
 * per credential id, so `list` is a single `HGETALL` and never returns a secret value. Revisions are
 * monotonic, so `getVersioned` + `setIf` give compare-and-set for OAuth refresh across instances.
 * Pass `encryptionKey` to encrypt secrets at rest (AES-256-GCM, bound to the owner and id).
 *
 * ```ts
 * import { storedProviderKeys } from "@tanstack/ai/byok/server";
 * import { upstashCredentials } from "@upstash/agentkit-tanstack-ai/byok";
 *
 * const credentials = upstashCredentials({ encryptionKey: process.env.CREDENTIALS_KEY });
 * const keys = storedProviderKeys(credentials, { userId, tenantId });
 * ```
 */
export function upstashCredentials(config: UpstashCredentialsConfig = {}): CredentialStore {
  const redis = config.redis ?? RedisClient.fromEnv();
  addTelemetry(redis, config.enableTelemetry);
  const p = config.prefix ?? "agentkit:tanstack";
  const counter = `${p}:credentialRevision`;
  const owner = (scope: CredentialScope) =>
    `${p}:credentials:${seg(scope.tenantId)}:${seg(scope.userId)}`;

  if (config.requireEncryption && config.encryptionKey === undefined) {
    throw new Error("@upstash/agentkit-tanstack-ai: `requireEncryption` needs an `encryptionKey`.");
  }
  const box = config.encryptionKey === undefined ? undefined : secretBox(config.encryptionKey);
  // Bind the ciphertext to its owner, id and the clear-text type/expiry that `list` shows.
  const aad = (scope: CredentialScope, id: string, type: string, expiresAt: number | undefined) =>
    JSON.stringify([owner(scope), id, type, expiresAt ?? null]);

  /** The JSON text after `{"r":N,` for a credential. */
  async function pack(scope: CredentialScope, id: string, credential: Credential): Promise<string> {
    const stored: Omit<Stored, "r"> = {
      t: credential.type,
      ...(credential.type !== "api_key" && credential.expiresAt !== undefined
        ? { x: credential.expiresAt }
        : {}),
    };
    if (box) {
      Object.assign(stored, await box.seal(credential, aad(scope, id, stored.t, stored.x)));
    } else {
      stored.c = credential;
    }
    return JSON.stringify(stored).slice(1);
  }

  async function unpack(scope: CredentialScope, id: string, stored: Stored): Promise<Credential> {
    if (stored.c) {
      if (config.requireEncryption) {
        throw new Error(
          `@upstash/agentkit-tanstack-ai: credential ${JSON.stringify(id)} is not encrypted, and \`requireEncryption\` is on.`,
        );
      }
      return stored.c;
    }
    if (!stored.ct || !stored.iv) {
      throw new Error(
        `@upstash/agentkit-tanstack-ai: credential ${JSON.stringify(id)} is corrupt.`,
      );
    }
    if (!box) {
      throw new Error(
        `@upstash/agentkit-tanstack-ai: credential ${JSON.stringify(id)} is encrypted; pass \`encryptionKey\`.`,
      );
    }
    return box.open<Credential>(
      { iv: stored.iv, ct: stored.ct },
      aad(scope, id, stored.t, stored.x),
    );
  }

  const checkId = (id: string) => {
    assertId(id, "id");
    // `list` builds an object keyed by id; `__proto__` would be silently dropped from it.
    if (id === "__proto__")
      throw new Error("@upstash/agentkit-tanstack-ai: `__proto__` is not a valid credential id.");
  };
  const read = async (scope: CredentialScope, id: string) => {
    checkId(id);
    return (await redis.hget<Stored>(owner(scope), id)) ?? null;
  };

  async function write(
    scope: CredentialScope,
    id: string,
    credential: Credential,
    compare?: { revision: string | null },
  ): Promise<number> {
    checkId(id);
    return (await redis.eval(
      SET,
      [owner(scope), counter],
      [id, await pack(scope, id, credential), compare ? "1" : "0", compare?.revision ?? ""],
    )) as number;
  }

  return {
    async get({ scope, id }) {
      const stored = await read(scope, id);
      return stored ? unpack(scope, id, stored) : null;
    },

    async getVersioned({ scope, id }) {
      const stored = await read(scope, id);
      return stored
        ? { credential: await unpack(scope, id, stored), revision: String(stored.r) }
        : null;
    },

    async set({ scope, id, credential }) {
      await write(scope, id, credential);
    },

    async setIf({ scope, id, credential, expectedRevision }) {
      const result = await write(scope, id, credential, { revision: expectedRevision });
      return result === -1
        ? { ok: false, reason: "conflict" }
        : { ok: true, revision: String(result) };
    },

    async delete({ scope, id }) {
      checkId(id);
      await redis.hdel(owner(scope), id);
    },

    async list(scope) {
      const all = (await redis.hgetall<Record<string, Stored>>(owner(scope))) ?? {};
      return Object.entries(all).map(([id, stored]) => ({
        id,
        type: stored.t,
        ...(stored.x !== undefined ? { expiresAt: stored.x } : {}),
      }));
    },
  };
}
