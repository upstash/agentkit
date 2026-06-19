import type { Span, SpanType, Telemetry } from "@upstash/agentkit-sdk";

export interface TraceRunConfig {
  /** The AgentKit {@link Telemetry} collector that records spans. */
  telemetry: Telemetry;
  /** Attach the run to an existing trace; a new trace is created when omitted. */
  traceId?: string;
  /** Span type; defaults to `"run"`. */
  type?: SpanType;
  /** Attributes to attach to the span up front. */
  attributes?: Record<string, unknown>;
}

/**
 * Convenience wrapper around {@link Telemetry.trace} for an Eve agent run. Runs `fn` inside a span,
 * recording success or the thrown error automatically; the live {@link Span} is passed to `fn` so it
 * can attach attributes (token counts, model id, cache hits) mid-flight.
 *
 * ```ts
 * const text = await traceRun({ telemetry }, "eve-agent-run", async (span) => {
 *   span.setAttribute("model", "claude-opus-4-8");
 *   return runEveAgent(input);
 * });
 * ```
 */
export function traceRun<T>(
  config: TraceRunConfig,
  name: string,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  return config.telemetry.trace(name, fn, {
    type: config.type ?? "run",
    ...(config.traceId !== undefined ? { traceId: config.traceId } : {}),
    ...(config.attributes !== undefined ? { attributes: config.attributes } : {}),
  });
}
