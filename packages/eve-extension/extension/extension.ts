import { defineExtension } from "eve/extension";
import type { SessionContext } from "eve/tools";
import { z } from "zod";
import type { Redis } from "@upstash/redis";
import type { AnySearchSchema } from "@upstash/agentkit-sdk";

/**
 * The user all data is scoped under (the tenant boundary for memory and chat history). A string
 * shares one scope across all callers (fine for a single-user agent); a function derives it per call
 * from eve's `SessionContext` — the base both tool and hook `ctx` extend, so one function serves
 * every contribution (`(ctx) => ctx.session.auth.current?.principalId ?? …`). Defaults to the
 * authenticated principal (`auth.current`, falling back to `initiator`), then the session id.
 */
const userId = z.union([
  z.string().min(1),
  z.custom<(ctx: SessionContext) => string>((value) => typeof value === "function"),
]);

export default defineExtension({
  config: z.object({
    userId: userId.optional(),
    /** Upstash Redis client. Defaults to `Redis.fromEnv()` (`UPSTASH_REDIS_REST_URL`/`_TOKEN`). */
    redis: z.custom<Redis>((value) => typeof value === "object" && value !== null).optional(),
    /** Knobs for the `recall_memory` tool. */
    memory: z
      .object({
        /** Max memories returned by a recall. */
        topK: z.number().int().positive().optional(),
        /** Minimum BM25 relevance score for recall hits. */
        minScore: z.number().optional(),
      })
      .optional(),
    /**
     * Enables the `search` / `aggregate` / `count` tools over one Upstash Redis Search index. Without
     * this, those tools error at call time — configure it, or disable their slots with `disableTool()`.
     */
    search: z
      .object({
        /** The index schema, built with `s` from `@upstash/redis`. */
        schema: z.custom<AnySearchSchema>((value) => typeof value === "object" && value !== null),
        /** Index name. Defaults to `"agentkit:search"`. */
        indexName: z.string().min(1).optional(),
        /** Key prefix for indexed JSON documents. Defaults to `"<indexName>:"`. */
        prefix: z.string().min(1).optional(),
        /** Default page size for the `search` tool. Defaults to 10. */
        defaultLimit: z.number().int().positive().optional(),
      })
      .optional(),
    /**
     * Durable transcript capture into Upstash Redis `ChatHistory` (**off by default**): a hook
     * appends every user and assistant message as it streams, keyed by `userId` + session id. Pass
     * `true` to enable it with defaults, or an object to enable it and tune where chats are stored.
     */
    chatHistory: z
      .union([
        z.boolean(),
        z.object({
          /** Base key prefix for stored chats; defaults to `agentkit:chat`. */
          prefix: z.string().min(1).optional(),
          /** Redis Search index name. Defaults to the (identifier-safe) `prefix`. */
          indexName: z.string().min(1).optional(),
          /** Optional TTL (seconds) per chat. Omit for no expiry. */
          ttlSeconds: z.number().int().positive().optional(),
        }),
      ])
      .optional(),
  }),
});
