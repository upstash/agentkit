import type { Telemetry } from "./telemetry.js";
import type { ToolCache } from "./tool-cache.js";

/** Context handed to a tool's `execute`, modeled on the AI SDK v7 tool harness. */
export interface ToolContext {
  /** Aborts when the per-call timeout fires or the caller cancels. */
  signal: AbortSignal;
  /** The trace this execution belongs to, when telemetry is enabled. */
  traceId?: string;
  /** 0-based attempt index (incremented on retry). */
  attempt: number;
}

/** A tool the sandbox can run. */
export interface Tool<A = unknown, R = unknown> {
  name: string;
  description?: string;
  execute: (args: A, ctx: ToolContext) => Promise<R>;
}

export interface SandboxConfig {
  /** Abort a single tool execution after this many ms. Defaults to 30000. */
  timeoutMs?: number;
  /** Retry a failed execution up to this many times. Defaults to 0. */
  maxRetries?: number;
  /** Base delay between retries (ms); grows with exponential backoff. Defaults to 100. */
  retryDelayMs?: number;
  /** Record a span per execution when provided. */
  telemetry?: Telemetry;
  /** Transparently cache deterministic tool results when provided. */
  toolCache?: ToolCache;
}

export interface SandboxResult<R> {
  ok: boolean;
  toolName: string;
  value?: R;
  error?: Error;
  /** Number of attempts made (>= 1). */
  attempts: number;
  durationMs: number;
  /** True when the result was served from {@link ToolCache}. */
  cached: boolean;
}

/** Thrown when a tool exceeds its timeout. */
export class ToolTimeoutError extends Error {
  constructor(toolName: string, timeoutMs: number) {
    super(`Tool "${toolName}" timed out after ${timeoutMs}ms`);
    this.name = "ToolTimeoutError";
  }
}

/**
 * A controlled execution harness for agent tools. It wraps each tool call with a timeout (via
 * `AbortSignal`), bounded retries with exponential backoff, structured error capture, optional
 * telemetry spans, and optional result caching — so a misbehaving tool can't hang or crash the agent
 * loop. Inspired by the AI SDK v7 tool harness.
 */
export class Sandbox {
  private tools = new Map<string, Tool>();
  private timeoutMs: number;
  private maxRetries: number;
  private retryDelayMs: number;
  private telemetry?: Telemetry;
  private toolCache?: ToolCache;

  constructor(config: SandboxConfig = {}) {
    this.timeoutMs = config.timeoutMs ?? 30_000;
    this.maxRetries = config.maxRetries ?? 0;
    this.retryDelayMs = config.retryDelayMs ?? 100;
    this.telemetry = config.telemetry;
    this.toolCache = config.toolCache;
  }

  /** Register a tool so it can be run by name. */
  register<A, R>(tool: Tool<A, R>): this {
    this.tools.set(tool.name, tool as Tool);
    return this;
  }

  /** Whether a tool with this name is registered. */
  has(name: string): boolean {
    return this.tools.has(name);
  }

  /**
   * Run a registered tool, never throwing — failures (including timeouts) are returned as a structured
   * {@link SandboxResult}. Use {@link Sandbox.execute} if you prefer exceptions.
   */
  async run<R = unknown>(
    toolName: string,
    args: unknown,
    opts: { traceId?: string; signal?: AbortSignal } = {},
  ): Promise<SandboxResult<R>> {
    const tool = this.tools.get(toolName);
    const started = this.telemetry?.clock() ?? Date.now();
    if (!tool) {
      return {
        ok: false,
        toolName,
        error: new Error(`Unknown tool: ${toolName}`),
        attempts: 0,
        durationMs: 0,
        cached: false,
      };
    }

    const span = this.telemetry?.startSpan(toolName, {
      traceId: opts.traceId,
      type: "tool",
      attributes: { tool: toolName },
    });

    // Cache check.
    if (this.toolCache) {
      const hit = await this.toolCache.get<R>(toolName, args);
      if (hit) {
        const durationMs = (this.telemetry?.clock() ?? Date.now()) - started;
        span?.setAttributes({ cached: true, attempts: 0 });
        await span?.end({ status: "ok" });
        return { ok: true, toolName, value: hit.value, attempts: 0, durationMs, cached: true };
      }
    }

    let lastError: Error | undefined;
    let attempts = 0;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      attempts = attempt + 1;
      try {
        const value = (await this.withTimeout(tool, args, {
          attempt,
          traceId: opts.traceId,
          externalSignal: opts.signal,
        })) as R;
        if (this.toolCache) await this.toolCache.set(toolName, args, value);
        const durationMs = (this.telemetry?.clock() ?? Date.now()) - started;
        span?.setAttributes({ cached: false, attempts });
        await span?.end({ status: "ok" });
        return { ok: true, toolName, value, attempts, durationMs, cached: false };
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempt < this.maxRetries) {
          await delay(this.retryDelayMs * Math.pow(2, attempt));
        }
      }
    }

    const durationMs = (this.telemetry?.clock() ?? Date.now()) - started;
    span?.setAttributes({ cached: false, attempts });
    await span?.end({ error: lastError });
    return { ok: false, toolName, error: lastError, attempts, durationMs, cached: false };
  }

  /** Like {@link Sandbox.run} but throws on failure and returns the raw value. */
  async execute<R = unknown>(
    toolName: string,
    args: unknown,
    opts: { traceId?: string; signal?: AbortSignal } = {},
  ): Promise<R> {
    const result = await this.run<R>(toolName, args, opts);
    if (!result.ok) throw result.error ?? new Error(`Tool "${toolName}" failed`);
    return result.value as R;
  }

  private async withTimeout(
    tool: Tool,
    args: unknown,
    ctx: { attempt: number; traceId?: string; externalSignal?: AbortSignal },
  ): Promise<unknown> {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    ctx.externalSignal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await Promise.race([
        tool.execute(args, {
          signal: controller.signal,
          traceId: ctx.traceId,
          attempt: ctx.attempt,
        }),
        new Promise((_, reject) => {
          controller.signal.addEventListener(
            "abort",
            () => reject(new ToolTimeoutError(tool.name, this.timeoutMs)),
            { once: true },
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
      ctx.externalSignal?.removeEventListener("abort", onAbort);
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
