import { z } from "zod";
import { AgentMemory } from "@upstash/agentkit-sdk";
import { Redis } from "@upstash/redis";
import { defineTool } from "eve/tools";
import type { ToolContext, ToolDefinition } from "eve/tools";

/**
 * The user the memory is read/written under. A string shares all memory across callers (fine for a
 * single-user agent — avoid in multi-tenant production unless intentional). A function derives the
 * user per call from the tool input and Eve context (e.g. `(_, ctx) => ctx.session.auth.current.id`).
 */
export type MemoryUserId = string | ((input: Record<string, unknown>, ctx: ToolContext) => string);

export interface MemoryToolConfig {
  /** Required user — a shared string, or a per-call function deriving it from the context. */
  userId: MemoryUserId;
  /** Upstash Redis client. Defaults to `Redis.fromEnv()`. */
  redis?: Redis;
  /** Max memories returned by the recall tool. */
  topK?: number;
  /** Minimum relevance score for recall. */
  minScore?: number;
}

function resolveMemory(config: MemoryToolConfig): AgentMemory {
  return new AgentMemory({ redis: config.redis ?? Redis.fromEnv() });
}

function resolveUserId(config: MemoryToolConfig, input: Record<string, unknown>, ctx: ToolContext) {
  return typeof config.userId === "function" ? config.userId(input, ctx) : config.userId;
}

/**
 * A ready eve tool (already `defineTool`-branded) that lets the agent recall long-term memories. One
 * import, drop into a file — export it directly, no extra wrapping:
 *
 * ```ts
 * // agent/tools/recall_memory.ts
 * import { defineMemoryRecallTool } from "@upstash/agentkit-eve";
 *
 * export default defineMemoryRecallTool({ userId: (_, ctx) => ctx.session.id });
 * ```
 */
export function defineMemoryRecallTool(
  config: MemoryToolConfig,
): ToolDefinition<{ query?: string }, { text: string; score: number }[]> {
  const memory = resolveMemory(config);
  return defineTool({
    description:
      "Recall the user's long-term memories. Pass `query` to find memories about a specific topic. " +
      "To list ALL of the user's memories, call this with NO `query` at all — do not pass a " +
      'placeholder like "everything" or "all".',
    inputSchema: z.object({
      query: z
        .string()
        .optional()
        .describe(
          "Topic or keywords to search memories for. Leave this out entirely to return every " +
            "stored memory for the user.",
        ),
    }),
    execute: async ({ query }, ctx) => {
      // recall() falls back to "everything for the user" when a query matches nothing, so a
      // model that passes a placeholder like "everything" still gets results.
      const hits = await memory.recall({
        query,
        userId: resolveUserId(config, { query }, ctx),
        ...(config.topK !== undefined ? { topK: config.topK } : {}),
        ...(config.minScore !== undefined ? { minScore: config.minScore } : {}),
      });
      return hits.map((h) => ({ text: h.text, score: h.score }));
    },
  } as Parameters<typeof defineTool>[0]) as ToolDefinition<
    { query?: string },
    { text: string; score: number }[]
  >;
}

/**
 * A ready eve tool (already `defineTool`-branded) that lets the agent save a durable fact to
 * long-term memory. Export it directly, no extra wrapping.
 *
 * ```ts
 * // agent/tools/save_memory.ts
 * export default defineMemorySaveTool({ userId: (_, ctx) => ctx.session.id });
 * ```
 */
export function defineMemorySaveTool(
  config: MemoryToolConfig,
): ToolDefinition<{ text: string }, { id: string; saved: boolean }> {
  const memory = resolveMemory(config);
  return defineTool({
    description:
      "Save a durable fact about the user to long-term memory so it can be recalled in future " +
      "conversations (preferences, identity, goals, …).",
    inputSchema: z.object({
      text: z.string().describe("A concise, durable fact about the user to remember for later."),
    }),
    execute: async ({ text }, ctx) => {
      const record = await memory.add({ text, userId: resolveUserId(config, { text }, ctx) });
      return { id: record.id, saved: true };
    },
  } as Parameters<typeof defineTool>[0]) as ToolDefinition<
    { text: string },
    { id: string; saved: boolean }
  >;
}
