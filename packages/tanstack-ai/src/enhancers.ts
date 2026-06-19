import type { AgentMemory, SemanticCache } from "@upstash/agentkit-sdk";
import type { GenerateFn, TanStackMessage } from "./types.js";

export interface SemanticCacheOptions {
  cache: SemanticCache;
}

/**
 * Wrap a prompt-in/string-out generate function so semantically similar prompts are served from a
 * {@link SemanticCache} instead of hitting the model. On a miss the wrapped function runs and the
 * result is cached for next time — so a paraphrased prompt avoids a fresh model call.
 *
 * @example
 * ```ts
 * const cached = withSemanticCache(model.generate, { cache });
 * await cached("What is the capital of France?");
 * await cached("France's capital?"); // served from cache, no model call
 * ```
 */
export function withSemanticCache(
  generate: GenerateFn,
  options: SemanticCacheOptions,
): (prompt: string) => Promise<string> {
  return options.cache.wrap(async (prompt: string) => generate(prompt));
}

export interface MemoryOptions {
  memory: AgentMemory;
  /** Subject scope (e.g. user id) memories are isolated under. */
  scope?: string;
  /** Max memories to recall. Defaults to 5. */
  topK?: number;
  /** Similarity floor for recall. */
  minScore?: number;
  /** Header line prefixed to recalled memories. */
  header?: string;
  /** Role used for the injected context message. Defaults to `"system"`. */
  role?: "system" | "user";
}

export interface MemoryInjector {
  /**
   * Recall memories relevant to `query` and format them as a single context message, or `null` when
   * nothing relevant is found. Prepend the message to the conversation you send to the model.
   */
  recall(query: string): Promise<TanStackMessage | null>;
}

/**
 * Build a {@link MemoryInjector} that recalls long-term memories via AgentKit's {@link AgentMemory}
 * and formats them as a context message ready to prepend to a TanStack conversation. Keeps memory
 * usage consistent with the rest of the kit.
 *
 * @example
 * ```ts
 * const injector = withMemory({ memory, scope: "user-1" });
 * const context = await injector.recall("What are my preferences?");
 * const messages = context ? [context, ...conversation] : conversation;
 * ```
 */
export function withMemory(options: MemoryOptions): MemoryInjector {
  const { memory, scope, topK, minScore, header, role } = options;
  const headerText = header ?? "Relevant context from memory:";
  const messageRole = role ?? "system";
  return {
    async recall(query: string): Promise<TanStackMessage | null> {
      const recalled = await memory.recall(query, {
        topK: topK ?? 5,
        ...(scope !== undefined ? { scope } : {}),
        ...(minScore !== undefined ? { minScore } : {}),
      });
      if (recalled.length === 0) return null;
      const lines = recalled.map((m) => `- ${m.text}`).join("\n");
      return {
        role: messageRole,
        content: `${headerText}\n${lines}`,
      };
    },
  };
}
