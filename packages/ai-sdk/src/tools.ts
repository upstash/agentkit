import type { Sandbox, ToolCache } from "@upstash/agentkit-sdk";
import type { AiTool, ToolExecuteOptions } from "./types.js";

export interface WrapToolConfig {
  /**
   * Run the tool through this {@link Sandbox} (timeout, bounded retries, abort propagation, optional
   * telemetry). When omitted the tool runs directly but may still go through {@link WrapToolConfig.toolCache}.
   */
  sandbox?: Sandbox;
  /**
   * Memoize deterministic results in this {@link ToolCache}. When a {@link WrapToolConfig.sandbox} is
   * also given, prefer wiring caching into the sandbox itself; supplying it here caches around a
   * sandbox-less tool.
   */
  toolCache?: ToolCache;
  /** Trace id to attach the sandbox span to, when telemetry is enabled on the sandbox. */
  traceId?: string;
}

/**
 * Wrap an AI-SDK-style tool so its `execute` runs through AgentKit's hardening primitives. The
 * returned object keeps the AI SDK tool shape (`description`, `parameters`/`inputSchema`, `execute`)
 * so it can be handed straight to `generateText({ tools: { name: wrapped } })`.
 *
 * - With a {@link Sandbox}: each call gets a timeout, bounded retries with backoff, and the sandbox's
 *   `AbortSignal` is composed with the AI SDK's `abortSignal`. Failures surface as thrown errors
 *   (including `ToolTimeoutError`), which is what the AI SDK tool harness expects.
 * - With a {@link ToolCache}: identical arguments are served from cache, so the underlying `execute`
 *   runs at most once per distinct argument set.
 *
 * The original tool must define `execute` (provider-/client-executed tools have nothing to wrap).
 */
export function wrapTool<A = unknown, R = unknown>(
  name: string,
  aiTool: AiTool<A, R>,
  config: WrapToolConfig = {},
): AiTool<A, R> {
  const original = aiTool.execute;
  if (!original) {
    throw new Error(`wrapTool: tool "${name}" has no \`execute\` to wrap.`);
  }
  const { sandbox, toolCache, traceId } = config;

  const wrapped: AiTool<A, R> = {
    ...aiTool,
    execute: async (args: A, options: ToolExecuteOptions): Promise<R> => {
      if (sandbox) {
        // Register on first use so the same name can be re-wrapped idempotently.
        if (!sandbox.has(name)) {
          sandbox.register<A, R>({
            name,
            description: aiTool.description,
            execute: async (a, ctx) => original(a, { abortSignal: ctx.signal }) as Promise<R>,
          });
        }
        const runOpts: { traceId?: string; signal?: AbortSignal } = {};
        if (traceId !== undefined) runOpts.traceId = traceId;
        if (options.abortSignal !== undefined) runOpts.signal = options.abortSignal;
        return sandbox.execute<R>(name, args, runOpts);
      }

      if (toolCache) {
        const exec = toolCache.wrap<A, R>(
          name,
          (a) => Promise.resolve(original(a, options)) as Promise<R>,
        );
        return exec(args);
      }

      return original(args, options) as Promise<R>;
    },
  };
  return wrapped;
}

/**
 * Convenience wrapper for the common case of running an AI-SDK tool exclusively through a
 * {@link Sandbox} (timeout/retry/abort). Equivalent to {@link wrapTool} with only `sandbox` set.
 */
export function sandboxedTool<A = unknown, R = unknown>(
  name: string,
  aiTool: AiTool<A, R>,
  sandbox: Sandbox,
  opts: { traceId?: string } = {},
): AiTool<A, R> {
  const config: WrapToolConfig = { sandbox };
  if (opts.traceId !== undefined) config.traceId = opts.traceId;
  return wrapTool(name, aiTool, config);
}
