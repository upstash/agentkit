/**
 * Shared AgentKit wiring for the demo.
 *
 * To keep the demo runnable with ZERO credentials, every backing store is an in-memory test double
 * from `@upstash/agentkit-sdk/testing`, and the "LLM" is a deterministic `MockModel`. In a real app
 * you would swap these for `Redis.fromEnv()`, `upstashVectorStore(new Index())`, a real embedding
 * model, and a real chat model — the AgentKit APIs stay identical.
 *
 * Instances are cached on `globalThis` so they survive Next.js hot-reload / route re-imports within
 * a single dev server process (in-memory state would otherwise reset on every request).
 */
import {
  AgentMemory,
  ChatHistory,
  Rag,
  Sandbox,
  SemanticCache,
  Telemetry,
  ToolCache,
} from "@upstash/agentkit-sdk";
import {
  MemoryRedis,
  MemoryVectorStore,
  MockEmbedder,
  MockModel,
} from "@upstash/agentkit-sdk/testing";

type Cache = {
  embedder?: MockEmbedder;
  redis?: MemoryRedis;
  vector?: MemoryVectorStore;
  model?: MockModel;
};

const globalForAgentKit = globalThis as unknown as { __agentkit?: Cache };
const cache: Cache = (globalForAgentKit.__agentkit ??= {});

/** A tiny deterministic "assistant" so demo responses read like answers, not echoes. */
function fakeAssistant(prompt: string): string {
  const last = prompt.split("\n").filter(Boolean).pop() ?? prompt;
  const q = last.replace(/^(user|question|prompt)\s*:\s*/i, "").trim();
  if (/capital of france/i.test(q)) return "The capital of France is Paris.";
  if (/\b2\s*\+\s*2\b/.test(q)) return "2 + 2 = 4.";
  if (/upstash/i.test(q)) return "Upstash provides serverless Redis and Vector over HTTP.";
  return `Here is a concise answer to: "${q}".`;
}

export const embedder = (cache.embedder ??= new MockEmbedder());
export const redis = (cache.redis ??= new MemoryRedis());
export const vector = (cache.vector ??= new MemoryVectorStore({
  embed: (t) => embedder.embedOne(t),
}));
export const model = (cache.model ??= new MockModel({ fallback: fakeAssistant }));

/** A model-call counter so demos can prove a semantic-cache hit avoided the model. */
export function modelCalls(): number {
  return model.callCount;
}

/** Generate a response, recording the call on the shared MockModel. */
export const generate = (prompt: string): Promise<string> => model.generate(prompt);

// Pre-built core feature instances, all sharing the same backing stores.
export const memory = new AgentMemory({ vector, redis, embedder, namespace: "demo:memory" });
export const history = new ChatHistory({ redis, namespace: "demo:chat", maxMessages: 50 });
export const semanticCache = new SemanticCache({
  vector,
  embedder,
  namespace: "demo:semcache",
  minScore: 0.8,
});
export const toolCache = new ToolCache({ redis, namespace: "demo:tool", ttlSeconds: 300 });
export const telemetry = new Telemetry({ redis, namespace: "demo:telemetry" });
export const rag = new Rag({ vector, embedder, namespace: "demo:rag", chunkSize: 200, chunkOverlap: 40 });

/** A fresh sandbox per call site (tools are registered per demo). */
export function newSandbox() {
  return new Sandbox({ timeoutMs: 5_000, maxRetries: 1, telemetry, toolCache });
}
