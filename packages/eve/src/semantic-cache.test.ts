import { SemanticCache } from "@upstash/agentkit-sdk";
import { MemoryVectorStore, MockEmbedder, MockModel } from "@upstash/agentkit-sdk/testing";
import { beforeEach, describe, expect, it } from "vitest";
import { withSemanticCache, withSemanticCacheText } from "./semantic-cache.js";

describe("withSemanticCache", () => {
  let cache: SemanticCache;
  let model: MockModel;

  beforeEach(() => {
    const embedder = new MockEmbedder();
    const vector = new MemoryVectorStore({ embed: embedder.embedOne });
    cache = new SemanticCache({ vector, embedder, minScore: 0.9 });
    model = new MockModel({ fallback: (p) => `answer to: ${p}` });
  });

  it("serves a semantically similar prompt from cache, avoiding the model", async () => {
    const generate = withSemanticCache(
      async (args) => ({ text: await model.generate(args.prompt) }),
      { cache },
    );

    const first = await generate({ prompt: "What is the capital of France?" });
    expect(first.text).toBe("answer to: What is the capital of France?");
    expect(model.callCount).toBe(1);

    // Exact repeat -> identical embedding -> cache hit; model not called again.
    const second = await generate({ prompt: "What is the capital of France?" });
    expect(second.text).toBe("answer to: What is the capital of France?");
    expect(model.callCount).toBe(1);
  });

  it("calls the model on a miss for a dissimilar prompt", async () => {
    const generate = withSemanticCache(
      async (args) => ({ text: await model.generate(args.prompt) }),
      { cache },
    );
    await generate({ prompt: "completely unrelated alpha topic" });
    await generate({ prompt: "totally different beta subject matter" });
    expect(model.callCount).toBe(2);
  });

  it("withSemanticCacheText exposes the string-in/string-out shape", async () => {
    const generate = withSemanticCacheText((prompt) => model.generate(prompt), { cache });
    const a = await generate("hello world greeting");
    expect(a).toBe("answer to: hello world greeting");
    expect(model.callCount).toBe(1);

    const b = await generate("hello world greeting");
    expect(b).toBe("answer to: hello world greeting");
    expect(model.callCount).toBe(1);
  });
});
