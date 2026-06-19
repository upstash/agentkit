import type { Telemetry } from "@upstash/agentkit-sdk";
import type { GenerateTextResultLike, TokenUsageLike } from "./types.js";

export interface TracedGenerationConfig {
  /** The AgentKit {@link Telemetry} collector. */
  telemetry: Telemetry;
  /** Span name; defaults to `ai.generateText`. */
  name?: string;
  /** Model identifier recorded as a span attribute. */
  model?: string;
  /** Attach the span to an existing trace; otherwise a new trace id is created. */
  traceId?: string;
  /** Extra attributes to record on the span. */
  attributes?: Record<string, unknown>;
}

/** Normalize the AI SDK's various usage field names into a flat attribute bag. */
function usageAttributes(usage: TokenUsageLike | undefined): Record<string, unknown> {
  if (!usage) return {};
  const attrs: Record<string, unknown> = {};
  const promptTokens = usage.promptTokens ?? usage.inputTokens;
  const completionTokens = usage.completionTokens ?? usage.outputTokens;
  if (promptTokens !== undefined) attrs.promptTokens = promptTokens;
  if (completionTokens !== undefined) attrs.completionTokens = completionTokens;
  if (usage.totalTokens !== undefined) attrs.totalTokens = usage.totalTokens;
  return attrs;
}

/**
 * Run an AI-SDK-style generation inside a {@link Telemetry} `model` span, recording the model id and
 * token usage (when the result reports it). Success and thrown errors are captured automatically.
 *
 * ```ts
 * const result = await tracedGeneration(
 *   () => generateText({ model, prompt }),
 *   { telemetry, model: "gpt-4o", traceId },
 * );
 * ```
 */
export async function tracedGeneration<T extends GenerateTextResultLike>(
  generate: () => Promise<T>,
  config: TracedGenerationConfig,
): Promise<T> {
  const { telemetry, name = "ai.generateText", model, traceId, attributes } = config;
  const baseAttrs: Record<string, unknown> = { ...attributes };
  if (model !== undefined) baseAttrs.model = model;

  const spanOpts: { traceId?: string; type: "model"; attributes: Record<string, unknown> } = {
    type: "model",
    attributes: baseAttrs,
  };
  if (traceId !== undefined) spanOpts.traceId = traceId;

  const span = telemetry.startSpan(name, spanOpts);
  try {
    const result = await generate();
    span.setAttributes(usageAttributes(result.usage));
    await span.end({ status: "ok" });
    return result;
  } catch (err) {
    await span.end({ error: err });
    throw err;
  }
}
