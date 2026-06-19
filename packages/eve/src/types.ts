/**
 * Structural interfaces modeling **Eve, the Vercel agent framework**.
 *
 * Eve is new and emerging: it may not be installable from npm yet, and its exact API is unstable.
 * Just as the core `@upstash/agentkit-sdk` never imports `@upstash/redis` at runtime, this adapter
 * never imports an `eve` package. It codes against the minimal *structural shapes* below so it stays
 * fully buildable and unit-testable offline. `eve` is declared as an **optional** peer dependency —
 * install it in your app, but it is not required to compile or test this adapter.
 *
 * These shapes intentionally cover only the slice of Eve the adapter touches, modeled conceptually:
 * an agent has instructions (a system prompt), a set of tools, and a model; tools have an `execute`;
 * a run/step loop drives messages and state. Expect to adjust these as Eve stabilizes.
 */

/**
 * Structural shape of an **Eve tool execution context** — the second argument Eve passes to a tool's
 * `execute`. We rely only on `signal` (to support timeout/abort) but keep the bag open for forward
 * compatibility.
 */
export interface EveToolContext {
  /** Aborts when the run is cancelled or a per-call timeout fires. */
  signal?: AbortSignal;
  /** The tool-call id assigned by the model, when available. */
  toolCallId?: string;
  /** Open-ended: Eve may add more context fields over time. */
  [key: string]: unknown;
}

/**
 * Structural shape of an **Eve tool**. In Eve, an agent is given a list of tools; each tool has a
 * `name`, optional `description`/schema, and an async `execute`. We treat the schema as opaque.
 */
export interface EveTool<A = unknown, R = unknown> {
  name: string;
  description?: string;
  /** Opaque parameter/input schema (e.g. a Zod or JSON schema). Passed through untouched. */
  parameters?: unknown;
  execute: (args: A, ctx?: EveToolContext) => Promise<R> | R;
}

/**
 * Structural shape of an **Eve model**. Eve accepts either a model identifier string or a model
 * object; the adapter never calls it directly, so it is kept opaque.
 */
export type EveModel = string | { readonly modelId?: string; [key: string]: unknown };

/**
 * Structural shape of an **Eve message**. Eve drives a message/state loop; messages carry a role and
 * string content. We deliberately allow arbitrary roles (and normalize on conversion).
 */
export interface EveMessage {
  role: string;
  content: string;
  /** Optional participant/tool name. */
  name?: string;
  /** Open-ended for forward compatibility. */
  [key: string]: unknown;
}

/**
 * Structural shape of an **Eve agent definition / config**. This is what you pass when constructing
 * an Eve agent: a system prompt (`instructions`), its `tools`, and a `model`. {@link withAgentKit}
 * returns an augmented copy of this object.
 */
export interface EveAgentConfig {
  /** System prompt / behavioral instructions for the agent. */
  instructions?: string;
  /** The tools the agent may call. */
  tools?: EveTool[];
  /** The model the agent runs on (opaque to this adapter). */
  model?: EveModel;
  /** Open-ended: pass through any other Eve agent options untouched. */
  [key: string]: unknown;
}

/**
 * Structural shape of an **Eve generation result**. When wrapping a generate/step call we only read
 * `text`; everything else is preserved.
 */
export interface EveGenerateResult {
  text: string;
  [key: string]: unknown;
}

/** A `generate`-like function keyed by a single `prompt` string, as produced by an Eve model/step. */
export type EveGenerator = (args: {
  prompt: string;
}) => Promise<EveGenerateResult> | Promise<{ text: string }>;
