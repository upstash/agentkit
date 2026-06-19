import { MockModel } from "@upstash/agentkit-sdk/testing";
import { describe, expect, it } from "vitest";
import { SemanticLLMCache } from "./llm-cache.js";
import { cleanupKeys, hasRedisCreds, testRedis, uniqueNamespace } from "./test-support.js";

describe.skipIf(!hasRedisCreds)("SemanticLLMCache (live Redis)", () => {
  const redis = testRedis();

  it("misses then hits on a fuzzily-similar prompt", async () => {
    const namespace = uniqueNamespace("llmcache-hit");
    const cache = new SemanticLLMCache({ redis, namespace, minScore: 0.5 });
    const prompt = "What is the capital of France?";
    try {
      expect(await cache.lookup(prompt)).toBeNull();
      await cache.update(prompt, "llm-key", [{ text: "Paris" }]);
      await cache.searchIndex.waitIndexing();

      // A close variant sharing most words still resolves to the cached generation.
      const hit = await cache.lookup("What is the capital city of France");
      expect(hit).toEqual([{ text: "Paris" }]);
    } finally {
      await cache.searchIndex.drop().catch(() => {});
      await cleanupKeys(redis, namespace);
    }
  });

  it("misses on a dissimilar prompt", async () => {
    const namespace = uniqueNamespace("llmcache-miss");
    const cache = new SemanticLLMCache({ redis, namespace, minScore: 0.5 });
    try {
      await cache.update("What is the capital of France?", "llm-key", [{ text: "Paris" }]);
      await cache.searchIndex.waitIndexing();

      expect(await cache.lookup("quantum chromodynamics lecture notes")).toBeNull();
    } finally {
      await cache.searchIndex.drop().catch(() => {});
      await cleanupKeys(redis, namespace);
    }
  });

  it("avoids a model call on a cached prompt", async () => {
    const namespace = uniqueNamespace("llmcache-avoid");
    const cache = new SemanticLLMCache({ redis, namespace, minScore: 0.5 });
    const model = new MockModel({ responses: ["The capital of France is Paris."] });
    const prompt = "What is the capital of France?";
    try {
      // Simulate a LangChain-style cached generation flow.
      const generate = async (p: string): Promise<string> => {
        const cached = await cache.lookup(p);
        if (cached) return cached[0]!.text;
        const text = await model.generate(p);
        await cache.update(p, "llm-key", [{ text }]);
        return text;
      };

      const first = await generate(prompt);
      await cache.searchIndex.waitIndexing();
      const second = await generate(prompt);

      expect(first).toBe("The capital of France is Paris.");
      expect(second).toBe(first);
      // The model was only called once; the second request was served from cache.
      expect(model.callCount).toBe(1);
    } finally {
      await cache.searchIndex.drop().catch(() => {});
      await cleanupKeys(redis, namespace);
    }
  });

  it("update with an empty generation list is a no-op", async () => {
    const namespace = uniqueNamespace("llmcache-empty");
    const cache = new SemanticLLMCache({ redis, namespace });
    try {
      await cache.update("prompt", "llm-key", []);
      expect(await cache.lookup("prompt")).toBeNull();
    } finally {
      await cache.searchIndex.drop().catch(() => {});
      await cleanupKeys(redis, namespace);
    }
  });
});
