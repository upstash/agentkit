import { tool, type ToolExecutionOptions, type ToolSet } from "ai";
import { z } from "zod";
import { AgentMemory } from "@upstash/agentkit-sdk";
import { Redis } from "@upstash/redis";
import { addTelemetry } from "./telemetry.js";

/**
 * The user the memory is read/written under. A string shares all memory across callers (fine for a
 * single-user agent, avoid in multi-tenant prod) — or a function deriving the user per call from the
 * tool input and call options. Keys are `agentkit:memory:<userId>:<id>`.
 */
export type MemoryUserId =
  | string
  | ((input: unknown, options: ToolExecutionOptions<never>) => string);

export interface CreateMemoryToolsConfig {
  /** The user (e.g. a user id) the tools operate under — a string or a per-call function. */
  userId: MemoryUserId;
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
  /**
   * Report the sdk name + version to Upstash as a header on the requests made by your redis client.
   * Can also be disabled with the `UPSTASH_DISABLE_TELEMETRY` env var. Defaults to `true`.
   */
  enableTelemetry?: boolean;
}

/**
 * Build `recall_memory` and `save_memory` AI SDK tools backed by long-term {@link AgentMemory}. Spread
 * the returned map into `generateText({ tools })`. Pass only a `userId`; `redis` defaults to
 * `Redis.fromEnv()`.
 *
 * ```ts
 * const tools = createMemoryTools({ userId });
 * await generateText({ model, tools, stopWhen: stepCountIs(5), prompt });
 * ```
 */
export function createMemoryTools(config: CreateMemoryToolsConfig): ToolSet {
  const { enableTelemetry } = config;
  const redis = config.redis ?? Redis.fromEnv();
  addTelemetry(redis, enableTelemetry);
  const memory = new AgentMemory({
    redis,
    ...(enableTelemetry !== undefined ? { enableTelemetry } : {}),
  });
  return buildMemoryTools(memory, config);
}

/** The default tool names, shared with `createAgentMemory`'s instructions. */
export const DEFAULT_RECALL_TOOL_NAME = "recall_memory";
export const DEFAULT_SAVE_TOOL_NAME = "save_memory";

/**
 * Build the recall/save tool pair over an existing {@link AgentMemory}. Internal: shared by
 * {@link createMemoryTools} and `createAgentMemory().tools()` so both expose identical tools.
 */
export function buildMemoryTools(
  memory: AgentMemory,
  options: Pick<
    CreateMemoryToolsConfig,
    "userId" | "topK" | "minScore" | "recallToolName" | "saveToolName"
  >,
): ToolSet {
  const { userId, topK, minScore } = options;
  const recallName = options.recallToolName ?? DEFAULT_RECALL_TOOL_NAME;
  const saveName = options.saveToolName ?? DEFAULT_SAVE_TOOL_NAME;

  const resolveUserId = (input: unknown, options: ToolExecutionOptions<never>): string =>
    typeof userId === "function" ? userId(input, options) : userId;

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
        const hits = await memory.recall({
          query: input.query,
          userId: resolveUserId(input, options as ToolExecutionOptions<never>),
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
        const record = await memory.add({
          text: input.text,
          userId: resolveUserId(input, options as ToolExecutionOptions<never>),
        });
        return { id: record.id, saved: true };
      },
    }),
  };
}
