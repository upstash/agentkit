import { openai } from "@ai-sdk/openai";
import { generateText } from "ai";
import { afterAll, describe, expect, it } from "vitest";
import { rateLimitedModel, RateLimitExceededError } from "./rate-limit.js";
import {
  cleanupKeys,
  hasOpenAIKey,
  hasRedisCreds,
  TEST_MODEL,
  testRedis,
  uniqueNamespace,
} from "./test-support.js";

// End-to-end against a real OpenAI model (gpt-4o) + real Upstash Redis.
describe.skipIf(!hasRedisCreds || !hasOpenAIKey)("model middleware e2e (OpenAI + Redis)", () => {
  const redis = testRedis();

  afterAll(async () => {
    await cleanupKeys(redis, "test:aisdk-e2e");
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
