/**
 * Shared AgentKit wiring for the demo.
 *
 * To keep the demo runnable with ZERO credentials, every backing store is an in-memory test double
 * from `@upstash/agentkit-sdk/testing`, and the "LLM" is a deterministic `MockModel`. In a real app
 * you would swap these for `Redis.fromEnv()`, `upstashSearchStore(redis.search.index(...))`, and a
 * real chat model — the AgentKit APIs stay identical.
 *
 * Instances are cached on `globalThis` so they survive Next.js hot-reload / route re-imports within
 * a single dev server process (in-memory state would otherwise reset on every request).
 *
 * `SearchStore` has no namespace concept, so each concern (memory vs semantic cache vs RAG) gets its
 * OWN search store via `searchStore(name)` — otherwise a cache lookup could match a memory or a RAG
 * chunk. With real Upstash you would model this with separate indexes (or a discriminator filter).
 */
import { MemoryRedis, MemorySearchStore, MockModel } from "@upstash/agentkit-sdk/testing";

type Cache = {
  redis?: MemoryRedis;
  model?: MockModel;
  stores?: Record<string, MemorySearchStore>;
};

const globalForAgentKit = globalThis as unknown as { __agentkit?: Cache };
const cache: Cache = (globalForAgentKit.__agentkit ??= {});

/** A tiny deterministic "assistant" so demo responses read like answers, not echoes. */
function fakeAssistant(prompt: string): string {
  const last = prompt.split("\n").filter(Boolean).pop() ?? prompt;
  const q = last.replace(/^(user|question|prompt)\s*:\s*/i, "").trim();
  if (/capital of france/i.test(q)) return "The capital of France is Paris.";
  if (/\b2\s*\+\s*2\b/.test(q)) return "2 + 2 = 4.";
  if (/upstash/i.test(q)) return "Upstash provides serverless Redis and Redis Search over HTTP.";
  return `Here is a concise answer to: "${q}".`;
}

export const redis = (cache.redis ??= new MemoryRedis());
export const model = (cache.model ??= new MockModel({ fallback: fakeAssistant }));

/** Get (or lazily create) a named, process-persistent in-memory search store. */
export function searchStore(name: string): MemorySearchStore {
  const stores = (cache.stores ??= {});
  return (stores[name] ??= new MemorySearchStore());
}

/** A model-call counter so demos can prove a semantic-cache hit avoided the model. */
export function modelCalls(): number {
  return model.callCount;
}

/** Generate a response, recording the call on the shared MockModel. */
export const generate = (prompt: string): Promise<string> => model.generate(prompt);
