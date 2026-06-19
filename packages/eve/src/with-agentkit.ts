import { AgentMemory, Rag, ToolCache } from "@upstash/agentkit-sdk";
import type { Redis } from "@upstash/redis";
import { createMemoryHooks } from "./memory.js";
import type { MemoryHooks } from "./memory.js";
import { cacheTools } from "./tools.js";
import type { EveAgentConfig } from "./types.js";

export interface WithAgentKitConfig {
  /** The Upstash Redis client — enables tool caching, memory, and RAG. */
  redis?: Redis;
  /** Memory/RAG scope (e.g. a user id). Defaults to `"default"`. */
  scope?: string;

  /** Pre-built memory; built from `redis` when omitted (and `redis` is present). */
  memory?: AgentMemory;
  /** Pre-built RAG; built from `redis` when omitted. Enable injection via `useRag`. */
  rag?: Rag;
  /** Inject retrieved RAG chunks into the instructions. Requires `redis` or a `rag` instance. */
  useRag?: boolean;
  /** Inject recalled memories into the instructions. Requires `redis` or a `memory` instance. */
  useMemory?: boolean;
  /** Seed used for memory recall / RAG retrieval when augmenting instructions. */
  context?: string;

  /** How many memories / RAG chunks to inject. Defaults to 5. */
  topK?: number;
}

export interface AgentKitAugmentation {
  /** The augmented Eve agent config: cached tools and memory/RAG-augmented instructions. */
  agent: EveAgentConfig;
  /** Memory hooks bound to `scope`, when memory is available. */
  memory?: MemoryHooks;
}

/**
 * Wire AgentKit into an Eve agent config. Returns an augmented copy of `agentConfig` whose tools are
 * memoized via a {@link ToolCache} and whose instructions are augmented with recalled long-term
 * memories ({@link AgentMemory}) and/or RAG context ({@link Rag}) relevant to `context`. Everything is
 * backed by Upstash Redis and opt-in by what you pass; the original `agentConfig` is never mutated.
 *
 * For code-execution sandboxing, see the `upstash()` backend in `@upstash/agentkit-eve/sandbox`.
 */
export async function withAgentKit(
  agentConfig: EveAgentConfig,
  config: WithAgentKitConfig,
): Promise<AgentKitAugmentation> {
  const scope = config.scope ?? "default";
  const toolCache = config.redis ? new ToolCache({ redis: config.redis }) : undefined;

  const tools = agentConfig.tools ?? [];
  const wrappedTools =
    tools.length > 0 && toolCache !== undefined ? cacheTools(tools, { toolCache }) : tools;

  const memory =
    config.memory ?? (config.redis ? new AgentMemory({ redis: config.redis }) : undefined);
  const memoryHooks = memory ? createMemoryHooks({ memory, scope, topK: config.topK }) : undefined;

  const rag = config.rag ?? (config.redis ? new Rag({ redis: config.redis }) : undefined);

  const blocks: string[] = [];
  if (agentConfig.instructions) blocks.push(agentConfig.instructions);

  if (config.useMemory && memoryHooks && config.context) {
    const recalled = await memoryHooks.recall(config.context);
    if (recalled) blocks.push(recalled);
  }

  if (config.useRag && rag && config.context) {
    const chunks = await rag.retrieve(config.context, { topK: config.topK ?? 5 });
    if (chunks.length > 0) {
      const lines = chunks.map((c) => `- ${c.text}`);
      blocks.push(`Relevant context:\n${lines.join("\n")}`);
    }
  }

  const agent: EveAgentConfig = {
    ...agentConfig,
    ...(blocks.length > 0 ? { instructions: blocks.join("\n\n") } : {}),
    tools: wrappedTools,
  };

  return {
    agent,
    ...(memoryHooks !== undefined ? { memory: memoryHooks } : {}),
  };
}
