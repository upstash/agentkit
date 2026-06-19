import { z } from "zod";
import type { AgentMemory } from "@upstash/agentkit-sdk";
import type { EveToolDefinition } from "./types.js";

export interface MemoryToolConfig {
  /** The {@link AgentMemory} the tool reads from / writes to. */
  memory: AgentMemory;
  /** Scope (e.g. a user id) the tool operates under. Defaults to `"default"`. */
  scope?: string;
  /** Max memories returned by the recall tool. */
  topK?: number;
  /** Minimum relevance score for recall. */
  minScore?: number;
}

/**
 * A `defineTool` config that lets the agent recall long-term memories. Drop it into an Eve tools file:
 *
 * ```ts
 * // agent/tools/recall_memory.ts
 * import { defineTool } from "eve/tools";
 * import { AgentMemory } from "@upstash/agentkit-sdk";
 * import { recallMemoryTool } from "@upstash/agentkit-eve";
 * import { redis } from "../redis";
 *
 * export default defineTool(recallMemoryTool({ memory: new AgentMemory({ redis }), scope: userId }));
 * ```
 */
export function recallMemoryTool(
  config: MemoryToolConfig,
): EveToolDefinition<{ query: string }, { text: string; score: number }[]> {
  const { memory, scope, topK, minScore } = config;
  return {
    description:
      "Recall relevant long-term memories about the user before answering. Call this when prior " +
      "context about the user would help.",
    inputSchema: z.object({
      query: z.string().describe("What to recall — the user's question, topic, or keywords."),
    }),
    execute: async ({ query }) => {
      const hits = await memory.recall(query, {
        ...(scope !== undefined ? { scope } : {}),
        ...(topK !== undefined ? { topK } : {}),
        ...(minScore !== undefined ? { minScore } : {}),
      });
      return hits.map((h) => ({ text: h.text, score: h.score }));
    },
  };
}

/**
 * A `defineTool` config that lets the agent save a durable fact to long-term memory.
 *
 * ```ts
 * // agent/tools/save_memory.ts
 * export default defineTool(saveMemoryTool({ memory: new AgentMemory({ redis }), scope: userId }));
 * ```
 */
export function saveMemoryTool(
  config: MemoryToolConfig,
): EveToolDefinition<{ text: string }, { id: string; saved: boolean }> {
  const { memory, scope } = config;
  return {
    description:
      "Save a durable fact about the user to long-term memory so it can be recalled in future " +
      "conversations (preferences, identity, goals, …).",
    inputSchema: z.object({
      text: z.string().describe("A concise, durable fact about the user to remember for later."),
    }),
    execute: async ({ text }) => {
      const record = await memory.add(text, scope !== undefined ? { scope } : {});
      return { id: record.id, saved: true };
    },
  };
}
