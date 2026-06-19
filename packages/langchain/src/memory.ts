import { AgentMemory, type AgentMemoryConfig, type RecalledMemory } from "@upstash/agentkit-sdk";

export interface AgentKitMemoryConfig extends AgentMemoryConfig {
  /** Default recall scope (e.g. a user id). Defaults to `"default"`. */
  scope?: string;
  /** How many memories to recall per query. Defaults to 5. */
  topK?: number;
  /**
   * Header rendered above recalled memories in {@link AgentKitMemory.asContext}.
   * Defaults to `"Relevant memories:"`.
   */
  header?: string;
}

/**
 * A LangChain-friendly long-term memory helper backed by the AgentKit {@link AgentMemory}
 * (Upstash Redis Search). It lets you persist facts and recall the most relevant ones for a query,
 * formatting them as a context string you can splice into a prompt (e.g. as a system message or a
 * `{memory}` variable in a `PromptTemplate`).
 *
 * @example
 * ```ts
 * const memory = new AgentKitMemory({ search, scope: "user-42" });
 * await memory.remember("The user prefers metric units.");
 * const context = await memory.asContext("what units should I use?");
 * // "Relevant memories:\n- The user prefers metric units."
 * ```
 */
export class AgentKitMemory {
  private memory: AgentMemory;
  private scope: string;
  private topK: number;
  private header: string;

  constructor(config: AgentKitMemoryConfig) {
    const { scope, topK, header, ...memoryConfig } = config;
    this.memory = new AgentMemory(memoryConfig);
    this.scope = scope ?? "default";
    this.topK = topK ?? 5;
    this.header = header ?? "Relevant memories:";
  }

  /** Persist a memory. Returns the stored record. */
  async remember(
    text: string,
    opts: { metadata?: Record<string, unknown>; scope?: string } = {},
  ): Promise<RecalledMemory> {
    const record = await this.memory.add(text, {
      metadata: opts.metadata,
      scope: opts.scope ?? this.scope,
    });
    return { ...record, score: 1 };
  }

  /** Fuzzily recall the memories most relevant to `query`. */
  async recall(
    query: string,
    opts: { topK?: number; scope?: string; minScore?: number } = {},
  ): Promise<RecalledMemory[]> {
    return this.memory.recall(query, {
      topK: opts.topK ?? this.topK,
      scope: opts.scope ?? this.scope,
      minScore: opts.minScore,
    });
  }

  /**
   * Recall relevant memories for `query` and render them as a single context string, ready to inject
   * into a prompt. Returns an empty string when nothing relevant is found.
   */
  async asContext(
    query: string,
    opts: { topK?: number; scope?: string; minScore?: number } = {},
  ): Promise<string> {
    const recalled = await this.recall(query, opts);
    if (recalled.length === 0) return "";
    const lines = recalled.map((m) => `- ${m.text}`);
    return [this.header, ...lines].join("\n");
  }
}
