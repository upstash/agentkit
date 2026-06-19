/**
 * Structural interfaces for the TanStack AI surface this adapter targets.
 *
 * Like the core SDK (which never imports `@upstash/redis` at runtime), this package never imports a
 * real TanStack package. Instead it codes against the minimal, structural shapes below, so any
 * compatible TanStack AI version — or a plain object — can be passed in. `@tanstack/ai` is declared
 * only as an *optional* peer dependency; the package builds and tests fully offline.
 */

/** The roles TanStack AI uses for chat messages. */
export type TanStackRole = "system" | "user" | "assistant" | "tool";

/**
 * A TanStack-AI-style chat message. Mirrors the common shape used by TanStack chat stores: a stable
 * `id`, a `role`, and string `content`. Extra fields are tolerated and carried through round-trips.
 */
export interface TanStackMessage {
  /** Stable client/server id for the message. Optional on inbound messages. */
  id?: string;
  role: TanStackRole;
  content: string;
  /** Optional participant or tool name. */
  name?: string;
  /** Set for tool-result messages to correlate with the originating tool call. */
  toolCallId?: string;
  /** Unix epoch milliseconds. */
  createdAt?: number;
  /** Arbitrary extra fields are preserved across conversions. */
  [key: string]: unknown;
}

/**
 * A TanStack-AI-style tool/function definition. Only the fields this adapter needs are modeled; the
 * `execute` signature mirrors the typical `(input) => Promise<output>` contract.
 */
export interface TanStackTool<TInput = unknown, TOutput = unknown> {
  name: string;
  description?: string;
  /** JSON-schema-ish parameter definition; passed through untouched. */
  parameters?: unknown;
  execute: (input: TInput) => Promise<TOutput> | TOutput;
}

/** A generate function injected by the caller (so tests can mock the model). */
export type GenerateFn = (prompt: string) => Promise<string> | string;
