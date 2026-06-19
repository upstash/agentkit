/**
 * Shared AgentKit wiring for the demo.
 *
 * Everything runs on a real Upstash Redis (the SDK is redis-only now). Credentials come from the
 * repo-root `.env` (loaded below for local dev) or the platform environment. The "LLM" is a
 * deterministic `MockModel` so responses are reproducible without an API key.
 *
 * Clients/instances are cached on `globalThis` so they survive Next.js hot-reload across requests.
 */
import { resolve } from "node:path";
import { config } from "dotenv";
import { Redis } from "@upstash/redis";
import { MockModel } from "@upstash/agentkit-sdk/testing";

// Load repo-root .env for local dev (does not override platform env vars).
config({ path: resolve(process.cwd(), "../../.env") });

type Cache = { redis?: Redis; model?: MockModel; instances?: Record<string, unknown> };
const globalForDemo = globalThis as unknown as { __agentkit?: Cache };
const cache: Cache = (globalForDemo.__agentkit ??= {});

/** The shared Upstash Redis client (lazy — only constructed when a route actually runs). */
export function getRedis(): Redis {
  return (cache.redis ??= Redis.fromEnv());
}

/** Lazily build and cache a feature instance by key, so each route reuses one across requests. */
export function singleton<T>(key: string, factory: () => T): T {
  const instances = (cache.instances ??= {});
  return (instances[key] ??= factory()) as T;
}

/** A tiny deterministic "assistant" so demo responses read like answers, not echoes. */
function fakeAssistant(prompt: string): string {
  const last = prompt.split("\n").filter(Boolean).pop() ?? prompt;
  const q = last.replace(/^(user|question|prompt)\s*:\s*/i, "").trim();
  if (/capital of france/i.test(q)) return "The capital of France is Paris.";
  if (/upstash/i.test(q)) return "Upstash provides serverless Redis and Redis Search over HTTP.";
  return `Here is a concise answer to: "${q}".`;
}

export const model = (cache.model ??= new MockModel({ fallback: fakeAssistant }));

/** Model-call counter so demos can prove a semantic-cache hit avoided the model. */
export function modelCalls(): number {
  return model.callCount;
}

/** Generate a response, recording the call on the shared MockModel. */
export const generate = (prompt: string): Promise<string> => model.generate(prompt);
