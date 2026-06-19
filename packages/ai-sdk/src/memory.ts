import { tool, type ToolExecutionOptions, type ToolSet } from "ai";
import { z } from "zod";
import { AgentMemory } from "@upstash/agentkit-sdk";
import { Redis } from "@upstash/redis";

/**
 * Scope the memory is read/written under. A string shares all memory across users (fine for a
 * single-user agent, avoid in multi-tenant prod) — or a function deriving the scope per call from the
 * tool input and call options (e.g. a user id).
 */
export type MemoryScope =
  | string
  | ((input: unknown, options: ToolExecutionOptions<never>) => string);

export interface CreateMemoryToolsConfig {
  /** Scope (e.g. a user id) the tools operate under — a string or a per-call function. */
  scope: MemoryScope;
  /** Upstash Redis client. Defaults to `Redis.fromEnv()`. */
  redis?: Redis;
  /** Pre-built memory (overrides `redis`). */
  memory?: AgentMemory;
  /** Max memories returned by the recall tool. */
  topK?: number;
  /** Minimum relevance score for recall. */
  minScore?: number;
  /** Override the recall tool's key/name. Defaults to `recall_memory`. */
  recallToolName?: string;
  /** Override the save tool's key/name. Defaults to `save_memory`. */
  saveToolName?: string;
}

/**
 * Build `recall_memory` and `save_memory` AI SDK tools backed by long-term {@link AgentMemory}. Spread
 * the returned map into `generateText({ tools })`. Pass only a `scope`; `redis` defaults to
 * `Redis.fromEnv()`.
 *
 * ```ts
 * const tools = createMemoryTools({ scope: userId });
 * await generateText({ model, tools, stopWhen: stepCountIs(5), prompt });
 * ```
 */
export function createMemoryTools(config: CreateMemoryToolsConfig): ToolSet {
  const { scope, topK, minScore } = config;
  const memory = config.memory ?? new AgentMemory({ redis: config.redis ?? Redis.fromEnv() });
  const recallName = config.recallToolName ?? "recall_memory";
  const saveName = config.saveToolName ?? "save_memory";

  const resolveScope = (input: unknown, options: ToolExecutionOptions<never>): string =>
    typeof scope === "function" ? scope(input, options) : scope;

  return {
    [recallName]: tool({
      description:
        "Recall relevant long-term memories about the user before answering. Call this when prior " +
        "context about the user would help.",
      inputSchema: z.object({
        query: z.string().describe("What to recall — the user's question, topic, or keywords."),
      }),
      execute: async (input, options) => {
        const hits = await memory.recall(input.query, {
          scope: resolveScope(input, options as ToolExecutionOptions<never>),
          ...(topK !== undefined ? { topK } : {}),
          ...(minScore !== undefined ? { minScore } : {}),
        });
        return hits.map((h) => ({ text: h.text, score: h.score }));
      },
    }),
    [saveName]: tool({
      description:
        "Save a durable fact about the user to long-term memory so it can be recalled in future " +
        "conversations (preferences, identity, goals, …).",
      inputSchema: z.object({
        text: z.string().describe("A concise, durable fact about the user to remember for later."),
      }),
      execute: async (input, options) => {
        const record = await memory.add(input.text, {
          scope: resolveScope(input, options as ToolExecutionOptions<never>),
        });
        return { id: record.id, saved: true };
      },
    }),
  };
}
