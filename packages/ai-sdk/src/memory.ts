import { z } from "zod";
import type { AgentMemory } from "@upstash/agentkit-sdk";
import type { AiTool } from "./types.js";

export interface CreateMemoryToolsConfig {
  /** The {@link AgentMemory} the tools read from / write to. */
  memory: AgentMemory;
  /** Scope (e.g. a user id) the tools operate under. Defaults to `"default"`. */
  scope?: string;
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
 * Build two AI SDK tools — `recall_memory` and `save_memory` — that let the model read and write the
 * agent's long-term memory. Spread them into `generateText({ tools })`.
 *
 * ```ts
 * const tools = createMemoryTools({ memory: new AgentMemory({ redis }), scope: userId });
 * await generateText({ model, tools, stopWhen: stepCountIs(5), prompt });
 * ```
 */
export function createMemoryTools(config: CreateMemoryToolsConfig): Record<string, AiTool> {
  const { memory, scope, topK, minScore } = config;
  const recallName = config.recallToolName ?? "recall_memory";
  const saveName = config.saveToolName ?? "save_memory";

  const recallInput = z.object({
    query: z.string().describe("What to recall — the user's question, topic, or keywords."),
  });
  const saveInput = z.object({
    text: z.string().describe("A concise, durable fact about the user to remember for later."),
  });

  const recall: AiTool = {
    description:
      "Recall relevant long-term memories about the user before answering. Call this when prior " +
      "context about the user would help.",
    parameters: recallInput,
    inputSchema: recallInput,
    execute: async (args) => {
      const { query } = args as { query: string };
      const hits = await memory.recall(query, {
        ...(scope !== undefined ? { scope } : {}),
        ...(topK !== undefined ? { topK } : {}),
        ...(minScore !== undefined ? { minScore } : {}),
      });
      return hits.map((h) => ({ text: h.text, score: h.score }));
    },
  };

  const save: AiTool = {
    description:
      "Save a durable fact about the user to long-term memory so it can be recalled in future " +
      "conversations (preferences, identity, goals, …).",
    parameters: saveInput,
    inputSchema: saveInput,
    execute: async (args) => {
      const { text } = args as { text: string };
      const record = await memory.add(text, scope !== undefined ? { scope } : {});
      return { id: record.id, saved: true };
    },
  };

  return { [recallName]: recall, [saveName]: save };
}
