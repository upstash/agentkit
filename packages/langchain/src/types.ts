/**
 * Minimal **structural** interfaces that mirror the LangChain.js extension points this adapter
 * integrates with.
 *
 * This package never imports a real LangChain package at runtime — exactly the way the core SDK
 * avoids importing `@upstash/redis`. `@langchain/core` is an *optional* peer dependency. By coding
 * against the structural shapes below, the package builds, type-checks, and tests fully offline, and
 * the classes here remain duck-type compatible with their LangChain counterparts: a real
 * `HumanMessage`, `Document`, `BaseRetriever`, or `BaseCache` satisfies these interfaces, and the
 * objects produced here can be handed back to LangChain.
 */

/**
 * Structural form of a LangChain message. LangChain represents messages either as message class
 * instances (`HumanMessage`, `AIMessage`, …) exposing `_getType()`, or — in many helper APIs — as
 * plain `{ role, content }` tuples. This interface accepts either shape so callers can pass whatever
 * they already have.
 */
export interface BaseMessageLike {
  /** Free-form text content of the message. */
  content: string;
  /**
   * LangChain message-class discriminator, returned by `BaseMessage._getType()`
   * (`"human" | "ai" | "system" | "tool" | …`). Present on real message instances.
   */
  _getType?: () => string;
  /** Plain-object role discriminator (`"human" | "ai" | "user" | "assistant" | "system" | "tool"`). */
  role?: string;
  /** Optional participant / tool name. */
  name?: string;
  /** Correlates a `tool` message with the tool call it answers. */
  tool_call_id?: string;
  /** Arbitrary additional fields LangChain attaches; tolerated and ignored. */
  additional_kwargs?: Record<string, unknown>;
}

/**
 * Structural form of a LangChain `Document`. Retrievers return arrays of these; the real
 * `Document` class from `@langchain/core/documents` is assignable to it.
 */
export interface DocumentLike {
  pageContent: string;
  metadata?: Record<string, unknown>;
}

/**
 * Structural form of a LangChain `BaseRetriever`. LangChain exposes both the legacy
 * `getRelevantDocuments(query)` and the runnable `invoke(query)`; this adapter implements both.
 */
export interface RetrieverLike {
  getRelevantDocuments(query: string): Promise<DocumentLike[]>;
  invoke(query: string): Promise<DocumentLike[]>;
}

/**
 * Structural form of a LangChain `BaseCache`. The cache key in LangChain is `(prompt, llmKey)`;
 * a generation is represented as `{ text }`. This adapter keys purely on the prompt text (semantic
 * similarity does the rest) and ignores `llmKey`.
 */
export interface CacheLike {
  lookup(prompt: string, llmKey?: string): Promise<GenerationLike[] | null>;
  update(prompt: string, llmKey: string, value: GenerationLike[]): Promise<void>;
}

/** Structural form of a LangChain `Generation`. */
export interface GenerationLike {
  text: string;
}

/**
 * Structural form of a LangChain `StructuredTool` / `DynamicTool`. Real LangChain tools expose a
 * `name`, optional `description`, and an invocation method (`invoke`, and/or the underlying `func`).
 * This adapter accepts any of them so it can wrap tools defined via `tool()`, `DynamicTool`, or a
 * plain object.
 */
export interface ToolLike<A = unknown, R = unknown> {
  name: string;
  description?: string;
  /** Runnable-style invocation (LangChain `Runnable.invoke`). */
  invoke?: (input: A) => Promise<R> | R;
  /** Raw function form (LangChain `DynamicTool.func`). */
  func?: (input: A) => Promise<R> | R;
}

/**
 * Structural form of a LangChain `BaseChatMessageHistory`. Real chat-history backends implement this
 * surface; the {@link RedisChatMessageHistory} in this package does too.
 */
export interface ChatMessageHistoryLike {
  getMessages(): Promise<BaseMessageLike[]>;
  addMessage(message: BaseMessageLike): Promise<void>;
  addUserMessage(text: string): Promise<void>;
  addAIMessage(text: string): Promise<void>;
  clear(): Promise<void>;
}
