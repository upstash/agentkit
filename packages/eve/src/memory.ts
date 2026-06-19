import type { AgentMemory } from "@upstash/agentkit-sdk";

export interface MemoryHooksConfig {
  /** The AgentKit {@link AgentMemory} backing long-term recall. */
  memory: AgentMemory;
  /** Memory scope (e.g. a user id or agent id). Defaults to `"default"`. */
  scope?: string;
  /** How many memories to recall per call. Defaults to 5. */
  topK?: number;
  /** Similarity floor for recall. */
  minScore?: number;
  /** Heading prepended to the formatted recall block. */
  header?: string;
}

export interface MemoryHooks {
  /**
   * Recall memories relevant to `input` and format them as a context string suitable for injecting
   * into an Eve agent's instructions. Returns an empty string when nothing is recalled.
   */
  recall(input: string): Promise<string>;
  /** Persist a piece of text as a long-term memory under the configured scope. */
  remember(text: string, opts?: { metadata?: Record<string, unknown> }): Promise<void>;
}

/**
 * Build recall/remember hooks over an AgentKit {@link AgentMemory}, scoped to a subject. `recall`
 * produces a ready-to-inject context block; `remember` persists new memories.
 *
 * ```ts
 * const hooks = createMemoryHooks({ memory, scope: "user-123" });
 * const context = await hooks.recall("what language do I prefer?");
 * // -> "Relevant memories:\n- The user prefers TypeScript"
 * await hooks.remember("The user prefers TypeScript");
 * ```
 */
export function createMemoryHooks(config: MemoryHooksConfig): MemoryHooks {
  const scope = config.scope ?? "default";
  const header = config.header ?? "Relevant memories:";
  return {
    async recall(input: string): Promise<string> {
      const recalled = await config.memory.recall(input, {
        scope,
        topK: config.topK ?? 5,
        ...(config.minScore !== undefined ? { minScore: config.minScore } : {}),
      });
      if (recalled.length === 0) return "";
      const lines = recalled.map((m) => `- ${m.text}`);
      return `${header}\n${lines.join("\n")}`;
    },
    async remember(text: string, opts = {}): Promise<void> {
      await config.memory.add(text, {
        scope,
        ...(opts.metadata !== undefined ? { metadata: opts.metadata } : {}),
      });
    },
  };
}
