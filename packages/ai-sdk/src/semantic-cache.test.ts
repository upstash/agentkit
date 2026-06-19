import { SemanticCache } from "@upstash/agentkit-sdk";
import { MemoryVectorStore, MockEmbedder, MockModel } from "@upstash/agentkit-sdk/testing";
import { beforeEach, describe, expect, it } from "vitest";
import { withSemanticCache, withSemanticCacheText } from "./semantic-cache.js";

describe("withSemanticCache", () => {
  let cache: SemanticCache;
  let embedder: MockEmbedder;

  beforeEach(() => {
    embedder = new MockEmbedder();
    const vector = new MemoryVectorStore({ embed: embedder.embedOne });
    cache = new SemanticCache({ vector, embedder, minScore: 0.9 });
  });

  it("caches a miss then serves a semantically similar prompt without calling the model", async () => {
    const model = new MockModel({ fallback: () => "Paris" });
    const generate = withSemanticCache(
      async (args) => ({ text: await model.generate(args.prompt) }),
      { cache },
    );

    const first = await generate({ prompt: "What is the capital of France?" });
    expect(first.text).toBe("Paris");
    expect(model.callCount).toBe(1);

    // A paraphrase shares most tokens, so it should be a cache hit.
    const second = await generate({ prompt: "What is the capital of France???" });
    expect(second.text).toBe("Paris");
    expect(model.callCount).toBe(1);
  });

  it("calls the model again for a dissimilar prompt", async () => {
    const model = new MockModel({ responses: ["Paris", "Berlin"] });
    const generate = withSemanticCache(
      async (args) => ({ text: await model.generate(args.prompt) }),
      { cache },
    );
    await generate({ prompt: "capital of France" });
    await generate({ prompt: "capital of Germany" });
    expect(model.callCount).toBe(2);
  });

  it("withSemanticCacheText keeps the string-in/string-out shape", async () => {
    const model = new MockModel({ fallback: () => "Paris" });
    const generate = withSemanticCacheText((prompt) => model.generate(prompt), { cache });
    expect(await generate("capital of France")).toBe("Paris");
    expect(await generate("capital of France!")).toBe("Paris");
    expect(model.callCount).toBe(1);
  });
});
