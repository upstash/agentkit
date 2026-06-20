import { tool, type ToolExecutionOptions, type ToolSet } from "ai";
import { z } from "zod";
import { AgentMemory } from "@upstash/agentkit-sdk";
import { Redis } from "@upstash/redis";

/**
 * Namespace the memory is read/written under. A string shares all memory across users (fine for a
 * single-user agent, avoid in multi-tenant prod) — or a function deriving the namespace per call from
 * the tool input and call options (e.g. a user id). Keys are `agentkit:memory:<namespace>:<id>`.
 */
export type MemoryNamespace =
  | string
  | ((input: unknown, options: ToolExecutionOptions<never>) => string);

export interface CreateMemoryToolsConfig {
  /** Namespace (e.g. a user id) the tools operate under — a string or a per-call function. */
  namespace: MemoryNamespace;
  /** Upstash Redis client. Defaults to `Redis.fromEnv()`. */
  redis?: Redis;
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
 * const tools = createMemoryTools({ namespace: userId });
 * await generateText({ model, tools, stopWhen: stepCountIs(5), prompt });
 * ```
 */
export function createMemoryTools(config: CreateMemoryToolsConfig): ToolSet {
  const { namespace, topK, minScore } = config;
  const memory = new AgentMemory({ redis: config.redis ?? Redis.fromEnv() });
  const recallName = config.recallToolName ?? "recall_memory";
  const saveName = config.saveToolName ?? "save_memory";

  const resolveNamespace = (input: unknown, options: ToolExecutionOptions<never>): string =>
    typeof namespace === "function" ? namespace(input, options) : namespace;

  return {
    [recallName]: tool({
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
      execute: async (input, options) => {
        // recall() falls back to "everything in the namespace" when a query matches nothing, so a
        // model that passes a placeholder like "everything" still gets results.
        const hits = await memory.recall(input.query, {
          namespace: resolveNamespace(input, options as ToolExecutionOptions<never>),
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
          namespace: resolveNamespace(input, options as ToolExecutionOptions<never>),
        });
        return { id: record.id, saved: true };
      },
    }),
  };
}
