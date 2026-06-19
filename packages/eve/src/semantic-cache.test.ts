import { SemanticCache } from "@upstash/agentkit-sdk";
import { MockModel } from "@upstash/agentkit-sdk/testing";
import { describe, expect, it } from "vitest";
import { withSemanticCache, withSemanticCacheText } from "./semantic-cache.js";
import { hasRedisCreds, testRedis, uniqueNamespace } from "./test-support.js";

describe.skipIf(!hasRedisCreds)("eve withSemanticCache (live Redis)", () => {
  const redis = testRedis();

  it("serves a fuzzily similar prompt from cache, avoiding the model", async () => {
    const cache = new SemanticCache({ redis, namespace: uniqueNamespace("eve-sc"), minScore: 0.5 });
    const model = new MockModel({ fallback: (p) => `answer to: ${p}` });
    const generate = withSemanticCache(
      async (args) => ({ text: await model.generate(args.prompt) }),
      { cache },
    );
    try {
      const first = await generate({ prompt: "What is the capital of France?" });
      expect(first.text).toBe("answer to: What is the capital of France?");
      expect(model.callCount).toBe(1);
      await cache.searchIndex.waitIndexing();

      const second = await generate({ prompt: "capital of France please" });
      expect(second.text).toBe("answer to: What is the capital of France?");
      expect(model.callCount).toBe(1);
    } finally {
      await cache.searchIndex.drop().catch(() => {});
    }
  });

  it("calls the model on a miss for a dissimilar prompt", async () => {
    const cache = new SemanticCache({ redis, namespace: uniqueNamespace("eve-sc"), minScore: 0.5 });
    const model = new MockModel({ fallback: (p) => `answer to: ${p}` });
    const generate = withSemanticCache(
      async (args) => ({ text: await model.generate(args.prompt) }),
      { cache },
    );
    try {
      await generate({ prompt: "kangaroo marsupial habitat facts" });
      await cache.searchIndex.waitIndexing();
      await generate({ prompt: "quantum chromodynamics lecture notes" });
      expect(model.callCount).toBe(2);
    } finally {
      await cache.searchIndex.drop().catch(() => {});
    }
  });

  it("withSemanticCacheText exposes the string-in/string-out shape", async () => {
    const cache = new SemanticCache({ redis, namespace: uniqueNamespace("eve-sc"), minScore: 0.5 });
    const model = new MockModel({ fallback: (p) => `answer to: ${p}` });
    const generate = withSemanticCacheText((prompt) => model.generate(prompt), { cache });
    try {
      expect(await generate("hello world greeting")).toBe("answer to: hello world greeting");
      expect(model.callCount).toBe(1);
      await cache.searchIndex.waitIndexing();
      expect(await generate("hello world greeting")).toBe("answer to: hello world greeting");
      expect(model.callCount).toBe(1);
    } finally {
      await cache.searchIndex.drop().catch(() => {});
    }
  });
});
