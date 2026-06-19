/**
 * Minimal structural types for the Vercel AI SDK tool shape, so the tool helpers in this package
 * (`cacheTools`, `createMemoryTools`, `createSearchTools`) return objects that drop straight into
 * `generateText({ tools })`. The model-caching helpers (`semanticCachedModel`) do import `ai`
 * directly, since they build on the AI SDK's language-model middleware.
 */

/**
 * Options passed by the AI SDK to a tool's `execute` (an `abortSignal`, the tool-call id, …). We only
 * pass them through to the wrapped tool.
 */
export interface ToolExecuteOptions {
  abortSignal?: AbortSignal;
  toolCallId?: string;
  [key: string]: unknown;
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
