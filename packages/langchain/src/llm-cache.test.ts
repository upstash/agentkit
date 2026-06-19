import { MemorySearchStore, MockModel } from "@upstash/agentkit-sdk/testing";
import { beforeEach, describe, expect, it } from "vitest";
import { SemanticLLMCache } from "./llm-cache.js";

describe("SemanticLLMCache", () => {
  let search: MemorySearchStore;

  beforeEach(() => {
    search = new MemorySearchStore();
  });

  it("misses then hits on a fuzzily-similar prompt", async () => {
    const cache = new SemanticLLMCache({ search, minScore: 0.5 });
    const prompt = "What is the capital of France?";

    expect(await cache.lookup(prompt)).toBeNull();
    await cache.update(prompt, "llm-key", [{ text: "Paris" }]);

    // A close variant sharing most words still resolves to the cached generation.
    const hit = await cache.lookup("What is the capital city of France");
    expect(hit).toEqual([{ text: "Paris" }]);
  });

  it("misses on a dissimilar prompt", async () => {
    const cache = new SemanticLLMCache({ search, minScore: 0.5 });
    await cache.update("What is the capital of France?", "llm-key", [{ text: "Paris" }]);

    expect(await cache.lookup("How do I bake sourdough bread at home?")).toBeNull();
  });

  it("avoids a model call on a cached prompt", async () => {
    const cache = new SemanticLLMCache({ search, minScore: 0.5 });
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
    const cache = new SemanticLLMCache({ search });
    await cache.update("prompt", "llm-key", []);
    expect(await cache.lookup("prompt")).toBeNull();
  });
});
