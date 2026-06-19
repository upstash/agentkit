/**
 * Structural interfaces mirroring the Vercel AI SDK (the `ai` package, v5+/v7).
 *
 * Just as the core `@upstash/agentkit-sdk` never imports `@upstash/redis` at runtime, this adapter
 * never imports the `ai` package. It codes against the minimal structural shapes below so it stays
 * fully buildable and unit-testable offline. The `ai` package is an *optional* peer dependency —
 * install it in your app, but it is not required to compile or test this adapter.
 *
 * These shapes intentionally cover only the slice of the AI SDK surface the adapter touches.
 */

/**
 * A message in the AI SDK "core message" shape. The real AI SDK allows `content` to be a string or
 * an array of structured parts; we accept `unknown` for `content` and normalize to/from plain
 * strings in {@link toCoreMessages}/{@link fromCoreMessages}.
 */
export interface CoreMessageLike {
  role: string;
  content: unknown;
  /** Optional participant/tool name (AI SDK carries this on some message kinds). */
  name?: string;
}

/** A single content part as emitted by the AI SDK when `content` is an array. */
export interface TextPartLike {
  type: string;
  /** Present on `{ type: "text" }` parts. */
  text?: string;
}

/**
 * Options passed by the AI SDK to a tool's `execute`. The AI SDK provides an `abortSignal` (and other
 * fields we don't use); we map it onto the AgentKit {@link import("@upstash/agentkit-sdk").ToolContext}.
 */
export interface ToolExecuteOptions {
  abortSignal?: AbortSignal;
  /** The tool-call id assigned by the model, when available. */
  toolCallId?: string;
}

/**
 * An AI-SDK-style tool. Created in app code via the AI SDK's `tool({ ... })` helper; here we only rely
 * on its structural shape. `execute` may be omitted for client-side / provider-executed tools.
 */
export interface AiTool<A = unknown, R = unknown> {
  description?: string;
  /** AI SDK v4 used `parameters`; v5+ uses `inputSchema`. Both are opaque schema objects to us. */
  parameters?: unknown;
  inputSchema?: unknown;
  execute?: (args: A, options: ToolExecuteOptions) => Promise<R> | R;
}

/** The result shape returned by the AI SDK's `generateText`. We only read `text` (+ optional usage). */
export interface GenerateTextResultLike {
  text: string;
  usage?: TokenUsageLike;
}

/** Token usage as reported by the AI SDK (field names vary across versions; all optional). */
export interface TokenUsageLike {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
}

/** A `generateText`-like function keyed by a single `prompt` string. */
export type PromptGenerator = (args: {
  prompt: string;
}) => Promise<GenerateTextResultLike> | Promise<{ text: string }>;
