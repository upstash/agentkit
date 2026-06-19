import { MemoryVectorStore, MockEmbedder, MockModel } from "@upstash/agentkit-sdk/testing";
import { beforeEach, describe, expect, it } from "vitest";
import { SemanticLLMCache } from "./llm-cache.js";

describe("SemanticLLMCache", () => {
  let vector: MemoryVectorStore;
  let embedder: MockEmbedder;

  beforeEach(() => {
    embedder = new MockEmbedder();
    vector = new MemoryVectorStore();
  });

  it("misses then hits on an identical prompt", async () => {
    const cache = new SemanticLLMCache({ vector, embedder, minScore: 0.9 });
    const prompt = "What is the capital of France?";

    expect(await cache.lookup(prompt)).toBeNull();
    await cache.update(prompt, "llm-key", [{ text: "Paris" }]);

    const hit = await cache.lookup(prompt);
    expect(hit).toEqual([{ text: "Paris" }]);
  });

  it("avoids a model call on a cached prompt", async () => {
    const cache = new SemanticLLMCache({ vector, embedder, minScore: 0.9 });
    const model = new MockModel({ responses: ["The capital of France is Paris."] });
    const prompt = "What is the capital of France?";

    // Simulate a LangChain-style cached generation flow.
    const generate = async (p: string): Promise<string> => {
      const cached = await cache.lookup(p);
      if (cached) return cached[0]!.text;
      const text = await model.generate(p);
      await cache.update(p, "llm-key", [{ text }]);
      return text;
    };

    const first = await generate(prompt);
    const second = await generate(prompt);

    expect(first).toBe("The capital of France is Paris.");
    expect(second).toBe(first);
    // The model was only called once; the second request was served from cache.
    expect(model.callCount).toBe(1);
  });

  it("update with an empty generation list is a no-op", async () => {
    const cache = new SemanticLLMCache({ vector, embedder });
    await cache.update("prompt", "llm-key", []);
    expect(await cache.lookup("prompt")).toBeNull();
  });
});
