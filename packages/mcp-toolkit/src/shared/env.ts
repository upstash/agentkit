/** Dependency-free helpers the generic layers share with the Upstash backends. */

/** JSON-RPC internal error. */
export const INTERNAL_ERROR = -32603;

/** An environment variable, or `undefined` where there is no `process` (edge runtimes). */
export function env(name: string): string | undefined {
  return typeof process === "object" ? process.env?.[name] : undefined;
}

/**
 * What a caller is told when a store, an `authorize` or another dependency throws. Their messages
 * can carry hostnames, URLs or credentials, so they go to the server log only.
 */
export const INTERNAL_ERROR_MESSAGE = "Internal error. Try again later.";

/** Logs an unexpected error that the caller only sees as {@link INTERNAL_ERROR_MESSAGE}. */
export function logInternalError(where: string, error: unknown): void {
  console.error(`[mcp-toolkit] ${where} failed:`, error);
}
