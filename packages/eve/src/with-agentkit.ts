import { AgentMemory, ChatHistory, Rag, Telemetry, ToolCache } from "@upstash/agentkit-sdk";
import type {
  RedisLike,
  Sandbox,
  SandboxConfig,
  SearchStore,
} from "@upstash/agentkit-sdk";
import { createHistoryHooks } from "./history.js";
import type { HistoryHooks } from "./history.js";
import { createMemoryHooks } from "./memory.js";
import type { MemoryHooks } from "./memory.js";
import { sandboxTools } from "./tools.js";
import { traceRun } from "./telemetry.js";
import type { EveAgentConfig } from "./types.js";

export interface WithAgentKitConfig {
  /** Redis client — enables chat history, tool caching, and telemetry. */
  redis?: RedisLike;
  /** Search store (Redis Search) — provide `search` for long-term memory recall and/or RAG context injection. */
  search?: SearchStore;
  /** Conversation session id. Required to persist chat history. */
  sessionId?: string;
  /** Memory/RAG scope (e.g. a user id). Defaults to `"default"`. */
  scope?: string;

  /** Pass a pre-built {@link Sandbox}; otherwise one is built from `sandboxConfig`. */
  sandbox?: Sandbox;
  /** Options for the auto-created {@link Sandbox} wrapping the agent's tools. */
  sandboxConfig?: SandboxConfig;

  /** Pre-built memory; built from `search` when omitted (and `search` is present). */
  memory?: AgentMemory;
  /** Pre-built RAG; built from `search` when omitted. Enable via `useRag`. */
  rag?: Rag;
  /** Inject retrieved RAG chunks into the instructions. Requires `search` or a `rag` instance. */
  useRag?: boolean;
  /** Inject recalled memories into the instructions. Requires `search` or a `memory` instance. */
  useMemory?: boolean;
  /** Seed used for memory recall / RAG retrieval when augmenting instructions. */
  context?: string;

  /** How many memories / RAG chunks to inject. Defaults to 5. */
  topK?: number;
}

export interface AgentKitAugmentation {
  /** The augmented Eve agent config: sandboxed+cached tools and augmented instructions. */
  agent: EveAgentConfig;
  /** History hooks bound to `sessionId`, when `redis` + `sessionId` were provided. */
  history?: HistoryHooks;
  /** Memory hooks bound to `scope`, when memory is available. */
  memory?: MemoryHooks;
  /** The telemetry collector, when `redis` was provided. */
  telemetry?: Telemetry;
  /**
   * Trace an Eve run with the configured telemetry. No-op (just runs `fn`) when telemetry is absent.
   */
  trace<T>(name: string, fn: () => Promise<T>): Promise<T>;
}

/**
 * Wire AgentKit into an Eve agent config. Returns an augmented copy of `agentConfig` whose:
 *
 * - **tools** are run through a {@link Sandbox} (timeout/retry/abort) and an optional {@link ToolCache}
 *   so identical calls are memoized — see {@link sandboxTools};
 * - **instructions** are augmented with recalled long-term memories ({@link AgentMemory}) and/or RAG
 *   context ({@link Rag}) relevant to `context`;
 *
 * plus ready-to-use {@link HistoryHooks} (persist the conversation via {@link ChatHistory}) and a
 * `trace` helper that records each run via {@link Telemetry}.
 *
 * Everything is opt-in by what you pass: provide `redis` for history/cache/telemetry, `search` for
 * memory/RAG. The original `agentConfig` is never mutated.
 *
 * ```ts
 * const { agent, history, trace } = await withAgentKit(
 *   { instructions: "You are a helpful assistant.", tools, model },
 *   { redis, search, sessionId: "s-1", scope: "user-123", useMemory: true, context: input },
 * );
 * const prior = await history?.load();
 * const text = await trace("run", () => runEveAgent(agent, [...(prior ?? []), userMessage]));
 * ```
 */
export async function withAgentKit(
  agentConfig: EveAgentConfig,
  config: WithAgentKitConfig,
): Promise<AgentKitAugmentation> {
  const scope = config.scope ?? "default";

  // --- Telemetry ---
  const telemetry = config.redis ? new Telemetry({ redis: config.redis }) : undefined;

  // --- Tool cache + sandbox ---
  const toolCache = config.redis ? new ToolCache({ redis: config.redis }) : undefined;
  const tools = agentConfig.tools ?? [];
  const wrappedTools =
    tools.length > 0
      ? sandboxTools(tools, {
          ...(config.sandbox !== undefined ? { sandbox: config.sandbox } : {}),
          sandboxConfig: {
            ...config.sandboxConfig,
            ...(telemetry !== undefined ? { telemetry } : {}),
          },
          ...(toolCache !== undefined ? { toolCache } : {}),
        })
      : tools;

  // --- Memory ---
  const memory =
    config.memory ??
    (config.search
      ? new AgentMemory({
          search: config.search,
          ...(config.redis !== undefined ? { redis: config.redis } : {}),
        })
      : undefined);
  const memoryHooks = memory ? createMemoryHooks({ memory, scope, topK: config.topK }) : undefined;

  // --- RAG ---
  const rag = config.rag ?? (config.search ? new Rag({ search: config.search }) : undefined);

  // --- Augment instructions with recalled memory + RAG context ---
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

  // --- History ---
  const history =
    config.redis && config.sessionId
      ? createHistoryHooks({
          history: new ChatHistory({ redis: config.redis }),
          sessionId: config.sessionId,
        })
      : undefined;

  const agent: EveAgentConfig = {
    ...agentConfig,
    ...(blocks.length > 0 ? { instructions: blocks.join("\n\n") } : {}),
    tools: wrappedTools,
  };

  return {
    agent,
    ...(history !== undefined ? { history } : {}),
    ...(memoryHooks !== undefined ? { memory: memoryHooks } : {}),
    ...(telemetry !== undefined ? { telemetry } : {}),
    trace<T>(name: string, fn: () => Promise<T>): Promise<T> {
      if (!telemetry) return fn();
      return traceRun({ telemetry }, name, () => fn());
    },
  };
}
