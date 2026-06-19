import type { AgentMemory, RecalledMemory } from "@upstash/agentkit-sdk";
import type { CoreMessageLike } from "./types.js";

export interface WithMemoryConfig {
  /** The AgentKit {@link AgentMemory} to recall from. */
  memory: AgentMemory;
  /** Recall scope (e.g. a user or agent id). Isolates memories per subject. */
  scope?: string;
  /** Max memories to recall per input. Defaults to 5. */
  topK?: number;
  /** Similarity floor for recall. */
  minScore?: number;
  /** Header line prepended to the recalled memories in the system message. */
  header?: string;
}

export interface MemoryInjector {
  /** Recall memories relevant to `input` for the configured scope. */
  recall(input: string): Promise<RecalledMemory[]>;
  /** Format recalled memories as a single system message, or `null` when nothing is relevant. */
  toSystemMessage(input: string): Promise<CoreMessageLike | null>;
  /** Prepend the recalled-memories system message to `messages`, if any. */
  inject(input: string, messages: CoreMessageLike[]): Promise<CoreMessageLike[]>;
}

const DEFAULT_HEADER = "Relevant memories about the user:";

/** Render recalled memories into the system-message body. */
function formatMemories(memories: RecalledMemory[], header: string): string {
  const lines = memories.map((m) => `- ${m.text}`);
  return [header, ...lines].join("\n");
}

/**
 * Build a memory injector that recalls relevant long-term memories for a user input and formats them
 * as a system message you can prepend to an AI SDK message array — giving the model durable context
 * without bloating the prompt with the entire memory store.
 *
 * ```ts
 * const injector = withMemory({ memory, scope: userId });
 * const messages = await injector.inject(input, [{ role: "user", content: input }]);
 * const result = await generateText({ model, messages });
 * ```
 */
export function withMemory(config: WithMemoryConfig): MemoryInjector {
  const { memory, scope, topK = 5, minScore, header = DEFAULT_HEADER } = config;

  const recall = async (input: string): Promise<RecalledMemory[]> => {
    const opts: { topK?: number; scope?: string; minScore?: number } = { topK };
    if (scope !== undefined) opts.scope = scope;
    if (minScore !== undefined) opts.minScore = minScore;
    return memory.recall(input, opts);
  };

  const toSystemMessage = async (input: string): Promise<CoreMessageLike | null> => {
    const memories = await recall(input);
    if (memories.length === 0) return null;
    return { role: "system", content: formatMemories(memories, header) };
  };

  return {
    recall,
    toSystemMessage,
    async inject(input, messages) {
      const sys = await toSystemMessage(input);
      return sys ? [sys, ...messages] : messages;
    },
  };
}
