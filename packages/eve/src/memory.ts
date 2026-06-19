import { z } from "zod";
import { AgentMemory } from "@upstash/agentkit-sdk";
import { Redis } from "@upstash/redis";
import type { ToolContext, ToolDefinition } from "eve/tools";

/**
 * Namespace the memory is read/written under. A string shares all memory across users (fine for a
 * single-user agent — avoid in multi-tenant production unless intentional). A function derives the
 * namespace per call from the tool input and Eve context (e.g. `(_, ctx) => ctx.session.auth.current.id`).
 */
export type MemoryNamespace =
  | string
  | ((input: Record<string, unknown>, ctx: ToolContext) => string);

export interface MemoryToolConfig {
  /** Required namespace — a shared string, or a per-call function deriving it from the context. */
  namespace: MemoryNamespace;
  /** Upstash Redis client. Defaults to `Redis.fromEnv()`. */
  redis?: Redis;
  /** Pre-built memory (overrides `redis`). */
  memory?: AgentMemory;
  /** Max memories returned by the recall tool. */
  topK?: number;
  /** Minimum relevance score for recall. */
  minScore?: number;
}

function resolveMemory(config: MemoryToolConfig): AgentMemory {
  return config.memory ?? new AgentMemory({ redis: config.redis ?? Redis.fromEnv() });
}

function resolveNamespace(
  config: MemoryToolConfig,
  input: Record<string, unknown>,
  ctx: ToolContext,
) {
  return typeof config.namespace === "function" ? config.namespace(input, ctx) : config.namespace;
}

/**
 * A `defineTool` config that lets the agent recall long-term memories. One import, drop into a file:
 *
 * ```ts
 * // agent/tools/recall_memory.ts
 * import { defineTool } from "eve/tools";
 * import { defineMemoryRecallTool } from "@upstash/agentkit-eve";
 *
 * export default defineTool(defineMemoryRecallTool({ namespace: (_, ctx) => ctx.session.id }));
 * ```
 */
export function defineMemoryRecallTool(
  config: MemoryToolConfig,
): ToolDefinition<{ query: string }, { text: string; score: number }[]> {
  const memory = resolveMemory(config);
  return {
    description:
      "Recall relevant long-term memories about the user before answering. Call this when prior " +
      "context about the user would help.",
    inputSchema: z.object({
      query: z.string().describe("What to recall — the user's question, topic, or keywords."),
    }),
    execute: async ({ query }, ctx) => {
      const hits = await memory.recall(query, {
        namespace: resolveNamespace(config, { query }, ctx),
        ...(config.topK !== undefined ? { topK: config.topK } : {}),
        ...(config.minScore !== undefined ? { minScore: config.minScore } : {}),
      });
      return hits.map((h) => ({ text: h.text, score: h.score }));
    },
  } as ToolDefinition<{ query: string }, { text: string; score: number }[]>;
}

/**
 * A `defineTool` config that lets the agent save a durable fact to long-term memory.
 *
 * ```ts
 * // agent/tools/save_memory.ts
 * export default defineTool(defineMemorySaveTool({ namespace: (_, ctx) => ctx.session.id }));
 * ```
 */
export function defineMemorySaveTool(
  config: MemoryToolConfig,
): ToolDefinition<{ text: string }, { id: string; saved: boolean }> {
  const memory = resolveMemory(config);
  return {
    description:
      "Save a durable fact about the user to long-term memory so it can be recalled in future " +
      "conversations (preferences, identity, goals, …).",
    inputSchema: z.object({
      text: z.string().describe("A concise, durable fact about the user to remember for later."),
    }),
    execute: async ({ text }, ctx) => {
      const record = await memory.add(text, { namespace: resolveNamespace(config, { text }, ctx) });
      return { id: record.id, saved: true };
    },
  } as ToolDefinition<{ text: string }, { id: string; saved: boolean }>;
}
