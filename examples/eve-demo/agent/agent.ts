import { openai } from "@ai-sdk/openai";
import { rateLimitedModel } from "@upstash/agentkit-eve";
import { defineAgent } from "eve";

import { redis } from "./redis.js";

// `defineAgent` accepts either a gateway model id string or a provider-authored
// AI SDK `LanguageModel`. We pass a `LanguageModel` so we can wrap it with the
// Upstash rate limiter before the agent ever calls it.
export default defineAgent({
  model: rateLimitedModel({
    model: openai("gpt-5.4-mini"), // the AI SDK LanguageModel to protect
    redis, // optional: Upstash client; defaults to Redis.fromEnv()
    limit: 20, // optional: requests allowed per window (default 10)
    window: "1 m", // optional: sliding-window duration (default "60 s")
    namespace: "agentkit:rateLimit", // optional: key prefix (plain string)
    identifier: "eve-demo", // optional: who to limit; defaults to "global"
    onLimit: "wait", // optional: "throw" (default) or "wait" for a free token
    waitTimeoutMs: 10_000, // optional: max wait when onLimit is "wait" (default 10000)
  }),
});
