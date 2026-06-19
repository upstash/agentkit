import { SemanticCache } from "@upstash/agentkit-sdk";
import { MockModel } from "@upstash/agentkit-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import { withSemanticCache, withSemanticCacheText } from "./semantic-cache.js";
import { hasRedisCreds, testRedis, uniqueNamespace } from "./test-support.js";

describe.skipIf(!hasRedisCreds)("withSemanticCache", () => {
  const redis = testRedis();
  // Each test gets its own index so entries never bleed across cases.
  const caches: SemanticCache[] = [];
  function newCache(): SemanticCache {
    // BM25 scores are unbounded; 0.5 reliably separates word-sharing hits from misses.
    const cache = new SemanticCache({
      redis,
      namespace: uniqueNamespace("semcache"),
      minScore: 0.5,
    });
    caches.push(cache);
    return cache;
  }

  afterEach(async () => {
    await Promise.all(caches.splice(0).map((c) => c.searchIndex.drop().catch(() => {})));
  });

  it("caches a miss then serves a fuzzily similar prompt without calling the model", async () => {
    const cache = newCache();
    const model = new MockModel({ fallback: () => "Paris" });
    const generate = withSemanticCache(
      async (args) => ({ text: await model.generate(args.prompt) }),
      { cache },
    );

    const first = await generate({ prompt: "What is the capital of France?" });
    expect(first.text).toBe("Paris");
    expect(model.callCount).toBe(1);

    await cache.searchIndex.waitIndexing();

    // A paraphrase shares the salient tokens, so it should be a cache hit.
    const second = await generate({ prompt: "the capital of France" });
    expect(second.text).toBe("Paris");
    expect(model.callCount).toBe(1);
  });

  it("calls the model again for a dissimilar prompt", async () => {
    const cache = newCache();
    const model = new MockModel({ responses: ["Paris", "tomato soup"] });
    const generate = withSemanticCache(
      async (args) => ({ text: await model.generate(args.prompt) }),
      { cache },
    );
    // No salient words in common, so the second prompt must miss and re-invoke the model.
    await generate({ prompt: "capital of France" });
    await cache.searchIndex.waitIndexing();
    await generate({ prompt: "easy weeknight dinner recipes" });
    expect(model.callCount).toBe(2);
  });

  it("withSemanticCacheText keeps the string-in/string-out shape", async () => {
    const cache = newCache();
    const model = new MockModel({ fallback: () => "Paris" });
    const generate = withSemanticCacheText((prompt) => model.generate(prompt), { cache });
    expect(await generate("capital of France")).toBe("Paris");
    await cache.searchIndex.waitIndexing();
    expect(await generate("the capital of France")).toBe("Paris");
    expect(model.callCount).toBe(1);
  });
});
