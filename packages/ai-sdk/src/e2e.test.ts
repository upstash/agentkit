import { openai } from "@ai-sdk/openai";
import { generateText } from "ai";
import { ModelCache } from "@upstash/agentkit-sdk";
import { afterAll, describe, expect, it } from "vitest";
import { rateLimitedModel, RateLimitExceededError } from "./rate-limit.js";
import { cachedModel } from "./model-cache.js";
import {
  cleanupKeys,
  hasOpenAIKey,
  hasRedisCreds,
  TEST_MODEL,
  testRedis,
  uniqueNamespace,
} from "./test-support.js";

// End-to-end against a real OpenAI model (gpt-4o-mini) + real Upstash Redis.
describe.skipIf(!hasRedisCreds || !hasOpenAIKey)("model middleware e2e (OpenAI + Redis)", () => {
  const redis = testRedis();

  afterAll(async () => {
    await cleanupKeys(redis, "test:aisdk-e2e");
  });

  it("cachedModel returns the cached result on a repeated prompt", async () => {
    const cache = new ModelCache({
      redis,
      namespace: uniqueNamespace("aisdk-e2e"),
      minScore: 0.5,
    });
    const model = cachedModel({ model: openai(TEST_MODEL), cache });

    const prompt = "In one short sentence, what is Upstash Redis?";
    const first = await generateText({ model, prompt });
    expect(first.text.length).toBeGreaterThan(0);

    // Wait for the write to be indexed so the repeat lookup can match it.
    await cache.searchIndex.waitIndexing();

    const second = await generateText({ model, prompt });
    // A fresh model call would almost never be byte-identical — equality proves the cache served it.
    expect(second.text).toBe(first.text);

    await cache.searchIndex.drop().catch(() => {});
  });

  it("rateLimitedModel blocks the call once the limit is exceeded", async () => {
    const model = rateLimitedModel({
      model: openai(TEST_MODEL),
      redis,
      limit: 1,
      window: "60 s",
      namespace: uniqueNamespace("aisdk-e2e-rl"),
      identifier: "e2e-user",
    });

    await generateText({ model, prompt: "Say hi." });
    await expect(generateText({ model, prompt: "Say hi again." })).rejects.toBeInstanceOf(
      RateLimitExceededError,
    );
  });
});
