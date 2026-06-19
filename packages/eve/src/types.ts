/**
 * Minimal structural types for the Eve framework. The adapter never imports a real `eve` package — it
 * codes against these shapes so it builds and tests offline. `eve` is an optional peer dependency.
 */

/** The context Eve passes as the second argument to a tool's `execute` (session, sandbox, …). */
export type EveToolContext = Record<string, unknown>;

/** An Eve tool's `execute` function: `(input, ctx) => result`. */
export type EveExecute<A = unknown, R = unknown> = (
  input: A,
  ctx?: EveToolContext,
) => Promise<R> | R;

/**
 * The config object you pass to Eve's `defineTool` — what the memory tool factories return so you can
 * drop them into `agent/tools/*.ts`.
 */
export interface EveToolDefinition<A = unknown, R = unknown> {
  description: string;
  inputSchema: unknown;
  execute: EveExecute<A, R>;
}
