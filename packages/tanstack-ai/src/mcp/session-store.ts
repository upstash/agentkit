import type { Redis } from "@upstash/redis";
import { Redis as RedisClient } from "@upstash/redis";
import type { McpServerDescriptor, McpSessionStore } from "@tanstack/ai-mcp/apps";
import { addTelemetry } from "../telemetry.js";
import { secretBox, type Sealed } from "../secret-box.js";

/** The parts of a descriptor that live in code, not in Redis: `resolve` supplies them per server. */
export interface McpSessionOverrides {
  toolFilter?: McpServerDescriptor["toolFilter"];
  needsApproval?: McpServerDescriptor["needsApproval"];
  toolName?: McpServerDescriptor["toolName"];
  clientOptions?: McpServerDescriptor["clientOptions"];
  requestOptions?: McpServerDescriptor["requestOptions"];
  /** Merged into an `http` / `sse` transport. */
  fetch?: typeof fetch;
  /** Merged into an `http` / `sse` transport (an OAuth client provider object). */
  authProvider?: unknown;
}

export interface McpSessionResolveContext {
  threadId: string;
  /** The server's key in the map passed to `set` (its `prefix` for `createMcpAppCallHandler`). */
  serverId: string;
  /** The stored descriptor: JSON fields and decrypted headers/env, without the code-only fields. */
  descriptor: McpServerDescriptor;
  /** Code-only fields the descriptor had when it was saved, e.g. `["needsApproval", "transport.fetch"]`. */
  missing: readonly string[];
}

export interface UpstashMcpSessionStoreConfig {
  /** Upstash Redis client. Defaults to `Redis.fromEnv()`. */
  redis?: Redis;
  /** Base key prefix. Defaults to `agentkit:tanstack`. */
  prefix?: string;
  /**
   * Supply the fields Redis cannot hold (functions and objects such as `needsApproval`,
   * `toolFilter` as a function, `toolName`, a transport's `fetch` / `authProvider`) for a stored
   * server. Called on every `get`. What you return is merged over the stored descriptor.
   *
   * A descriptor saved with such a field comes back only if `resolve` supplies it again: otherwise
   * `get` returns `null` (fail closed), so `createMcpAppCallHandler` falls back to the server's
   * registry entry, or refuses the call. A widget never reaches a server whose approval gate or tool
   * filter was dropped on the way through Redis.
   */
  resolve?: (
    context: McpSessionResolveContext,
  ) => McpSessionOverrides | undefined | Promise<McpSessionOverrides | undefined>;
  /**
   * Encrypt the transport's `headers` (often `Authorization`) and a stdio transport's `env` at rest
   * with AES-256-GCM, bound to the prefix, thread and server. A 32-byte key as a `Uint8Array`, or a
   * base64 / base64url / hex string (`openssl rand -base64 32`). Strongly recommended when headers
   * carry credentials: without it they are stored as plain JSON.
   */
  encryptionKey?: string | Uint8Array;
  /**
   * Forget a thread's servers this many seconds after its last `set` or `get` (sliding, like
   * `inMemoryMcpSessionStore`). @default 1800
   */
  ttlSeconds?: number;
  /** Set `false` to opt out of the telemetry header. */
  enableTelemetry?: boolean;
}

interface StoredServer {
  /** The JSON-safe part of the descriptor (headers/env removed when encrypted). */
  d: McpServerDescriptor;
  /** Sealed `{ headers?, env? }` of the transport, when an `encryptionKey` is set. */
  s?: Sealed;
  /** Paths of the code-only fields the descriptor had, which `resolve` must supply again. */
  m: string[];
}

const DESCRIPTOR_FIELDS = [
  "prefix",
  "clientOptions",
  "toolFilter",
  "needsApproval",
  "toolName",
  "requestOptions",
] as const;

/** A value that round-trips through JSON unchanged: plain objects, arrays, strings, finite numbers, booleans, null. */
function isJsonSafe(value: unknown): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonSafe);
  if (typeof value === "object") {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return false;
    return Object.values(value as object).every((v) => v === undefined || isJsonSafe(v));
  }
  return false;
}

/**
 * `McpSessionStore` (MCP Apps, `@tanstack/ai-mcp/apps`) on Upstash Redis: which MCP servers a thread
 * may call from its app widgets, so `createMcpAppCallHandler` can reconnect on any instance.
 *
 * A descriptor is split on `set`: its JSON part goes to Redis (one hash per thread, one field per
 * server), and anything that is not JSON (`needsApproval`, a function `toolFilter`, `toolName`, a
 * transport's `fetch` / `authProvider`) is dropped and recorded by name. `resolve` puts those back
 * on `get`, from your code, per server. If it does not, `get` returns `null` rather than a descriptor
 * missing its approval gate or tool filter. Transport headers and stdio env can be encrypted at rest.
 *
 * For servers you configure in code and pass to `createMcpAppCallHandler({ clients })`, the handler
 * already takes `toolFilter` / `needsApproval` / `toolName` / `requestOptions` from that registry when
 * the stored descriptor has none; `resolve` matters for servers that exist only per thread.
 *
 * @example
 * ```ts
 * import { createMcpAppCallHandler } from "@tanstack/ai-mcp/apps";
 * import { upstashMcpSessionStore } from "@upstash/agentkit-tanstack-ai/mcp";
 *
 * const store = upstashMcpSessionStore({
 *   encryptionKey: process.env.MCP_SESSION_KEY,
 *   resolve: ({ serverId }) => ({
 *     needsApproval: (tool) => tool.annotations?.readOnlyHint !== true,
 *   }),
 * });
 * const handleCall = createMcpAppCallHandler({ clients, store });
 * ```
 */
export function upstashMcpSessionStore(config: UpstashMcpSessionStoreConfig = {}): McpSessionStore {
  const redis = config.redis ?? RedisClient.fromEnv();
  addTelemetry(redis, config.enableTelemetry);
  const p = config.prefix ?? "agentkit:tanstack";
  const ttl = config.ttlSeconds ?? 1800;
  const box = config.encryptionKey === undefined ? undefined : secretBox(config.encryptionKey);
  const key = (threadId: string) => `${p}:mcp:session:${encodeURIComponent(threadId)}`;
  const aad = (threadId: string, serverId: string) =>
    `${p}\u0000mcp-session\u0000${threadId}\u0000${serverId}`;

  const pack = async (
    threadId: string,
    serverId: string,
    descriptor: McpServerDescriptor,
  ): Promise<StoredServer> => {
    const d: Record<string, unknown> = {};
    const m: string[] = [];
    for (const field of DESCRIPTOR_FIELDS) {
      const value = descriptor[field];
      if (value === undefined) continue;
      if (isJsonSafe(value)) d[field] = value;
      else m.push(field);
    }
    let sealed: Sealed | undefined;
    if (descriptor.transport !== undefined) {
      const transport: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(descriptor.transport)) {
        if (v === undefined) continue;
        if (isJsonSafe(v)) transport[k] = v;
        else m.push(`transport.${k}`);
      }
      if (box) {
        const secret: Record<string, unknown> = {};
        for (const k of ["headers", "env"]) {
          if (transport[k] !== undefined) {
            secret[k] = transport[k];
            delete transport[k];
          }
        }
        if (Object.keys(secret).length > 0)
          sealed = await box.seal(secret, aad(threadId, serverId));
      }
      d.transport = transport;
    }
    return { d: d as unknown as McpServerDescriptor, m, ...(sealed ? { s: sealed } : {}) };
  };

  const unpack = async (
    threadId: string,
    serverId: string,
    stored: StoredServer,
  ): Promise<McpServerDescriptor | null> => {
    const descriptor = { ...stored.d } as McpServerDescriptor & Record<string, unknown>;
    if (stored.s) {
      if (!box) {
        throw new Error(
          `@upstash/agentkit-tanstack-ai: MCP session server ${JSON.stringify(serverId)} has encrypted headers; pass \`encryptionKey\`.`,
        );
      }
      const secret = await box.open<Record<string, unknown>>(stored.s, aad(threadId, serverId));
      descriptor.transport = {
        ...descriptor.transport,
        ...secret,
      } as McpServerDescriptor["transport"];
    }
    const overrides = config.resolve
      ? await config.resolve({ threadId, serverId, descriptor, missing: stored.m })
      : undefined;
    const { fetch: fetchOverride, authProvider, ...fields } = overrides ?? {};
    Object.assign(descriptor, fields);
    if ((fetchOverride !== undefined || authProvider !== undefined) && descriptor.transport) {
      descriptor.transport = {
        ...descriptor.transport,
        ...(fetchOverride !== undefined ? { fetch: fetchOverride } : {}),
        ...(authProvider !== undefined ? { authProvider } : {}),
      } as McpServerDescriptor["transport"];
    }
    // Fail closed: every code-only field the descriptor was saved with must be back.
    for (const path of stored.m) {
      const [head, sub] = path.split(".") as [string, string | undefined];
      const holder = sub === undefined ? descriptor : (descriptor[head] as Record<string, unknown>);
      if (holder?.[sub ?? head] === undefined) return null;
    }
    return descriptor;
  };

  return {
    async set(threadId, servers) {
      const entries = await Promise.all(
        Object.entries(servers).map(
          async ([serverId, descriptor]) =>
            [serverId, JSON.stringify(await pack(threadId, serverId, descriptor))] as const,
        ),
      );
      const tx = redis.multi();
      tx.del(key(threadId));
      if (entries.length > 0) {
        tx.hset(key(threadId), Object.fromEntries(entries));
        if (ttl > 0) tx.expire(key(threadId), ttl);
      }
      await tx.exec();
    },

    async get(threadId, serverId) {
      let id: string;
      let stored: StoredServer;
      if (serverId === undefined) {
        // The widget omitted serverId: only a thread with exactly one server resolves.
        const all = await redis.hgetall<Record<string, StoredServer>>(key(threadId));
        const entries = Object.entries(all ?? {});
        if (entries.length !== 1) return null;
        [id, stored] = entries[0]!;
      } else {
        const one = await redis.hget<StoredServer>(key(threadId), serverId);
        if (!one) return null;
        [id, stored] = [serverId, one];
      }
      if (ttl > 0) await redis.expire(key(threadId), ttl);
      return unpack(threadId, id, stored);
    },
  };
}
