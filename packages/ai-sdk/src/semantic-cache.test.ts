import { SemanticCache } from "@upstash/agentkit-sdk";
import { afterAll, describe, expect, it, vi } from "vitest";
import { semanticCacheMiddleware } from "./semantic-cache.js";
import { cleanupKeys, hasRedisCreds, testRedis, uniqueNamespace } from "./test-support.js";

const userPrompt = (text: string) => [{ role: "user", content: [{ type: "text", text }] }];

describe.skipIf(!hasRedisCreds)("semanticCacheMiddleware (live Redis)", () => {
  const redis = testRedis();

  afterAll(async () => {
    await cleanupKeys(redis, "test:aisdk-mw");
  });

  it("serves a fuzzily similar prompt from cache, skipping the model", async () => {
    const cache = new SemanticCache({
      redis,
      namespace: uniqueNamespace("aisdk-mw"),
      minScore: 0.5,
    });
    const mw = semanticCacheMiddleware({ cache });

    const doGenerate = vi.fn(async () => ({
      content: [{ type: "text", text: "Paris" }],
      finishReason: "stop",
      usage: { inputTokens: 1, outputTokens: 1 },
    }));

    const first = (await mw.wrapGenerate!({
      doGenerate,
      params: { prompt: userPrompt("What is the capital of France?") },
    } as never)) as { content: { text: string }[] };
    expect(first.content[0]!.text).toBe("Paris");
    expect(doGenerate).toHaveBeenCalledTimes(1);

    await cache.searchIndex.waitIndexing();

    const second = (await mw.wrapGenerate!({
      doGenerate,
      params: { prompt: userPrompt("capital of France please") },
    } as never)) as { content: { text: string }[] };
    expect(second.content[0]!.text).toBe("Paris");
    expect(doGenerate).toHaveBeenCalledTimes(1); // served from cache

    await cache.searchIndex.drop().catch(() => {});
  });

  it("calls the model for an unrelated prompt", async () => {
    const cache = new SemanticCache({
      redis,
      namespace: uniqueNamespace("aisdk-mw"),
      minScore: 0.5,
    });
    const mw = semanticCacheMiddleware({ cache });
    const doGenerate = vi.fn(async () => ({ content: [{ type: "text", text: "x" }] }));

    await mw.wrapGenerate!({ doGenerate, params: { prompt: userPrompt("bake bread") } } as never);
    await cache.searchIndex.waitIndexing();
    await mw.wrapGenerate!({
      doGenerate,
      params: { prompt: userPrompt("quantum chromodynamics") },
    } as never);
    expect(doGenerate).toHaveBeenCalledTimes(2);

    await cache.searchIndex.drop().catch(() => {});
  });
});
