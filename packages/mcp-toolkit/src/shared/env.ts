/** Dependency-free helpers the generic layers share with the Upstash backends. */

/** JSON-RPC internal error. */
export const INTERNAL_ERROR = -32603;

/** An environment variable, or `undefined` where there is no `process` (edge runtimes). */
export function env(name: string): string | undefined {
  return typeof process === "object" ? process.env?.[name] : undefined;
}
