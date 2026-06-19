import type { Sandbox, ToolCache } from "@upstash/agentkit-sdk";
import type { ToolLike } from "./types.js";

/** Resolve the invocation function of a LangChain-style tool (`invoke` preferred, then `func`). */
function resolveInvoke<A, R>(tool: ToolLike<A, R>): (input: A) => Promise<R> {
  const fn = tool.invoke ?? tool.func;
  if (!fn) {
    throw new Error(`Tool "${tool.name}" has neither an \`invoke\` nor a \`func\` method to call.`);
  }
  return async (input: A) => fn.call(tool, input) as Promise<R> | R;
}

/**
 * Wrap a LangChain-style tool so its results are memoized in the AgentKit {@link ToolCache}
 * (Upstash Redis). Identical inputs are served from cache, skipping the wrapped tool's work — useful
 * for deterministic, expensive, or rate-limited tools that an agent may call repeatedly.
 *
 * The returned object keeps the tool's `name`/`description` and exposes both `invoke` and `func`
 * pointing at the cached implementation, so it stays drop-in compatible with whatever consumed the
 * original tool.
 *
 * @example
 * ```ts
 * const cached = cacheTool(searchTool, toolCache, { ttlSeconds: 300 });
 * await cached.invoke({ query: "upstash" }); // runs once
 * await cached.invoke({ query: "upstash" }); // served from cache
 * ```
 */
export function cacheTool<A, R>(
  tool: ToolLike<A, R>,
  cache: ToolCache,
  opts: { ttlSeconds?: number } = {},
): ToolLike<A, R> & { invoke: (input: A) => Promise<R>; func: (input: A) => Promise<R> } {
  const run = resolveInvoke(tool);
  const wrapped = cache.wrap<A, R>(tool.name, run, opts);
  return {
    name: tool.name,
    ...(tool.description !== undefined ? { description: tool.description } : {}),
    invoke: wrapped,
    func: wrapped,
  };
}

/**
 * Wrap a LangChain-style tool so every call runs inside the AgentKit {@link Sandbox} — gaining the
 * sandbox's timeout, bounded retries, optional telemetry spans, and optional tool caching. The tool
 * is registered with the sandbox under its name and executed via `sandbox.execute`, which throws on
 * failure (matching the throwing contract LangChain tools use).
 *
 * @example
 * ```ts
 * const safe = sandboxTool(flakyTool, new Sandbox({ timeoutMs: 5000, maxRetries: 2 }));
 * await safe.invoke({ url: "https://example.com" });
 * ```
 */
export function sandboxTool<A, R>(
  tool: ToolLike<A, R>,
  sandbox: Sandbox,
): ToolLike<A, R> & { invoke: (input: A) => Promise<R>; func: (input: A) => Promise<R> } {
  const run = resolveInvoke(tool);
  sandbox.register<A, R>({
    name: tool.name,
    ...(tool.description !== undefined ? { description: tool.description } : {}),
    execute: async (args: A) => run(args),
  });
  const wrapped = (input: A): Promise<R> => sandbox.execute<R>(tool.name, input);
  return {
    name: tool.name,
    ...(tool.description !== undefined ? { description: tool.description } : {}),
    invoke: wrapped,
    func: wrapped,
  };
}
