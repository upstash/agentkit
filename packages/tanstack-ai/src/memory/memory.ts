import type { Redis } from "@upstash/redis";
import { Redis as RedisClient, s } from "@upstash/redis";
import { z } from "zod";
import { AgentMemory, stableHash } from "@upstash/agentkit-sdk";
import type { AgentMemoryConfig } from "@upstash/agentkit-sdk";
import { toolDefinition } from "@tanstack/ai";
import type { Tool } from "@tanstack/ai";
import type {
  MemoryAdapter,
  MemoryFact,
  MemoryScope,
  RecallResult,
  SaveReceipt,
} from "@tanstack/ai-memory";
import { addTelemetry } from "../telemetry.js";

/** Where a memory came from — shown next to it in the recalled block, since they differ in weight. */
type Source = "agent" | "userMessage";

const METADATA = { source: s.string().noTokenize() };

/**
 * The core `AgentMemoryConfig` options this adapter passes through (`prefix`, `indexName`,
 * `minScore`, `enableTelemetry`), with `redis` optional, plus how the adapter scopes, recalls and
 * captures. `prefix` defaults to `agentkit:tanstackMemory` — its own keyspace (and search index),
 * because the store indexes a `source` field the plain `agentkit:memory` store does not have.
 */
export type UpstashMemoryConfig = Pick<
  AgentMemoryConfig,
  "prefix" | "indexName" | "minScore" | "enableTelemetry"
> & {
  /** Upstash Redis client. Defaults to `Redis.fromEnv()`. */
  redis?: Redis;
  /**
   * What memory is partitioned by. `"user"` keeps one long-term memory per user across every
   * thread (falling back to the thread when the scope has no `userId`); `"thread"` keeps it per
   * conversation. `tenantId` and `namespace` always partition as well.
   * @default "user"
   */
  scopeBy?: "user" | "thread";
  /**
   * Max memories injected per turn.
   * @default 5
   */
  topK?: number;
  /**
   * Store each turn's user message automatically. `false` = only what the model saves with the
   * `save_memory` tool.
   * @default true
   */
  captureUserMessages?: boolean;
  /**
   * Expose a `save_memory` tool so the model can store durable facts deliberately. Such facts are
   * labelled apart from captured messages in the recalled block.
   * @default true
   */
  saveTool?: boolean;
  /**
   * Name of the save tool.
   * @default "save_memory"
   */
  saveToolName?: string;
  /**
   * Longest message captured (characters); longer ones are truncated.
   * @default 2000
   */
  maxMemoryCharacters?: number;
  /**
   * Wait for the search index to catch up after each write, so a memory saved in one turn is
   * recallable on the very next one. Upstash Search indexing otherwise lags by minutes. Costs one
   * extra round trip per save, which `memoryMiddleware` runs after the response is delivered.
   * @default true
   */
  waitForIndexing?: boolean;
};

/** Escape one scope part so no value can forge a separator (`.`) or the key separator (`:`). */
const part = (v: string | undefined) =>
  v === undefined || v === ""
    ? "_"
    : encodeURIComponent(v).replace(/\./g, "%2E").replace(/_/g, "%5F");

/** The `AgentMemory` userId a scope maps to — `:`-free, so it is safe as a key part. */
export function memoryScopeKey(scope: MemoryScope, scopeBy: "user" | "thread" = "user"): string {
  const subject =
    scopeBy === "user" && scope.userId ? `u.${part(scope.userId)}` : `t.${part(scope.threadId)}`;
  return [part(scope.tenantId), part(scope.namespace), subject].join(".");
}

const LABEL: Record<Source, string> = {
  agent: "you saved this",
  userMessage: "the user said this",
};

/**
 * A TanStack AI `MemoryAdapter` on Upstash Redis Search — plug it into `memoryMiddleware()`.
 *
 * Unlike a plain key/value memory store, ranking happens **in the database**: recall is one BM25
 * `$smart` (typo-tolerant, fuzzy) query over the scope's memories, so it neither loads every record
 * per turn nor caps how many a user can have.
 *
 * - **recall** injects the top matches as a system-prompt block, each labelled with where it came
 *   from, and offers the `save_memory` tool.
 * - **save** captures the turn's user message (idempotent — the id is a hash of the text).
 *
 * ```ts
 * import { memoryMiddleware } from "@tanstack/ai-memory";
 * import { upstashMemory } from "@upstash/agentkit-tanstack-ai/memory";
 *
 * chat({
 *   adapter, messages,
 *   middleware: [memoryMiddleware({ adapter: upstashMemory(), scope: { threadId, userId } })],
 * });
 * ```
 */
export function upstashMemory(config: UpstashMemoryConfig = {}): MemoryAdapter {
  const redis = config.redis ?? RedisClient.fromEnv();
  addTelemetry(redis, config.enableTelemetry);
  const { prefix, indexName, minScore, enableTelemetry } = config;
  const memory = new AgentMemory({
    ...{ indexName, minScore, enableTelemetry },
    redis,
    prefix: prefix ?? "agentkit:tanstackMemory",
    metadataSchema: METADATA,
  });
  const scopeBy = config.scopeBy ?? "user";
  const topK = config.topK ?? 5;
  const maxChars = config.maxMemoryCharacters ?? 2_000;
  const capture = config.captureUserMessages ?? true;
  const toolName = config.saveToolName ?? "save_memory";

  const waitForIndexing = config.waitForIndexing ?? true;
  // Writes do not create the index, and waiting on a missing index is a silent no-op — a doc written
  // before the index exists can miss the create-time backfill. So the first write provisions it
  // (any read does, reactively), once per adapter.
  let provisioned: Promise<unknown> | undefined;

  const add = async (userId: string, text: string, source: Source) => {
    const trimmed = text.trim().slice(0, maxChars);
    provisioned ??= memory.count({ userId }).catch((error) => {
      provisioned = undefined;
      throw error;
    });
    await provisioned;
    // Identical text collapses onto one record, so capture is idempotent across turns and retries.
    const record = await memory.add({
      userId,
      text: trimmed,
      id: stableHash(trimmed).slice(0, 12),
      metadata: { source },
    });
    if (waitForIndexing) await memory.searchIndex.waitIndexing();
    return record;
  };

  const saveToolFor = (userId: string): Tool =>
    toolDefinition({
      name: toolName,
      description:
        "Save a durable fact about the user to long-term memory so it can be recalled in future " +
        "conversations (preferences, identity, goals, ...).",
      inputSchema: z.object({
        text: z.string().describe("A concise, durable fact about the user to remember for later."),
      }),
    }).server(async ({ text }: { text: string }) => {
      const record = await add(userId, text, "agent");
      return { id: record.id, saved: true };
    });

  return {
    id: "upstash",
    name: "Upstash Redis Search",

    async recall(scope, query): Promise<RecallResult> {
      const userId = memoryScopeKey(scope, scopeBy);
      const hits = await memory.recall({
        userId,
        query,
        topK,
      });
      const lines = hits.map((h) => {
        const source = h.metadata?.source as Source | undefined;
        return `- ${h.text}${source && LABEL[source] ? ` (${LABEL[source]})` : ""}`;
      });
      const withTool = config.saveTool ?? true;
      return {
        systemPrompt: lines.length
          ? `Relevant long-term memory about this user:\n${lines.join("\n")}`
          : "",
        fragments: hits.map((h) => ({ text: h.text, source: h.id })),
        ...(withTool
          ? {
              tools: [saveToolFor(userId)],
              toolGuidance: `Call \`${toolName}\` to remember durable facts about the user (preferences, identity, goals) for future conversations.`,
            }
          : {}),
        raw: hits,
      };
    },

    async save(scope, turn): Promise<SaveReceipt[]> {
      if (!capture || !turn.user.trim()) return [];
      const started = Date.now();
      try {
        await add(memoryScopeKey(scope, scopeBy), turn.user, "userMessage");
        return [{ ok: true, latencyMs: Date.now() - started }];
      } catch (error) {
        return [{ ok: false, error: error instanceof Error ? error.message : String(error) }];
      }
    },

    async listFacts(scope): Promise<MemoryFact[]> {
      // Every fact in the scope: `list` has no cursor, so size the page to the scope's count.
      const userId = memoryScopeKey(scope, scopeBy);
      const total = await memory.count({ userId });
      if (total === 0) return [];
      const records = await memory.list({ userId, limit: total });
      return records.map((r) => ({
        id: r.id,
        text: r.text,
        ...(r.metadata?.source ? { source: String(r.metadata.source) } : {}),
        createdAt: new Date(r.createdAt).toISOString(),
      }));
    },
  };
}
